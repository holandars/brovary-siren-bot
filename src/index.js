const ALERT_API = "https://neptun.in.ua/api/v1/alerts";

const DISTRICT_KEY = "броварський";
const STATE_KEY = "brovary_alert_state";

// 1 запуск Cron щохвилини.
// Усередині робимо 6 перевірок з інтервалом 10 секунд.
const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;

// Захист від накладання двох запусків Cron.
// ВАЖЛИВО: KV-lock не є атомарним 100% mutex.
// Для практичного захисту від звичайних overlap цього достатньо.
// Для строгого взаємного виключення потрібен Durable Object.
const LOCK_KEY = "brovary_alert_worker_lock";
const LOCK_TTL_SECONDS = 90;

const TELEGRAM_CHAT_ID = "@brovary_tryvoha";

export default {
  async scheduled(event, env, ctx) {
    await runChecks(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Ручний тест Telegram
    if (url.pathname === "/test") {
      try {
        await sendTelegram(
          env,
          `🧪 <b>ТЕСТ БОТА</b>\n\nБот працює коректно.`
        );

        return new Response("Test message sent", { status: 200 });
      } catch (error) {
        return new Response(
          `Telegram error: ${error.message}`,
          { status: 500 }
        );
      }
    }

    // Ручний запуск перевірки
    if (url.pathname === "/check") {
      try {
        await checkAlert(env);

        return new Response("Check completed", { status: 200 });
      } catch (error) {
        return new Response(
          `Check error: ${error.message}`,
          { status: 500 }
        );
      }
    }

    return new Response("Brovary alert worker is running.");
  },
};


// ============================================================
// ОСНОВНИЙ ЦИКЛ
// ============================================================

async function runChecks(env) {
  const lockId = crypto.randomUUID();

  // Перевіряємо, чи вже працює інший Cron
  const existingLock = await env.ALERT_STATE.get(LOCK_KEY);

  if (existingLock) {
    console.log("Another worker run is already active.");
    return;
  }

  // Створюємо lock
  await env.ALERT_STATE.put(
    LOCK_KEY,
    lockId,
    {
      expirationTtl: LOCK_TTL_SECONDS,
    }
  );

  try {
    for (let i = 0; i < CHECKS_PER_RUN; i++) {
      console.log(`Alert check ${i + 1}/${CHECKS_PER_RUN}`);

      try {
        await checkAlert(env);
      } catch (error) {
        console.error("Alert check failed:", error);
      }

      // Не чекаємо після останньої перевірки
      if (i < CHECKS_PER_RUN - 1) {
        await sleep(CHECK_INTERVAL_MS);
      }
    }
  } finally {
    // Видаляємо lock тільки якщо це наш lock
    const currentLock = await env.ALERT_STATE.get(LOCK_KEY);

    if (currentLock === lockId) {
      await env.ALERT_STATE.delete(LOCK_KEY);
    }
  }
}


// ============================================================
// ПЕРЕВІРКА ТРИВОГИ
// ============================================================

async function checkAlert(env) {
  const response = await fetch(ALERT_API, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "BrovaryAlertBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `NEPTUN API returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  // Нас цікавить ТІЛЬКИ наявність Броварського району.
  // yellow/red повністю ігноруємо.
  const alert = (data.raions || []).find(
    item => item.key === DISTRICT_KEY
  );

  const isActive = Boolean(alert);

  const oldState = await getState(env);

  console.log(
    JSON.stringify({
      isActive,
      oldActive: oldState.active,
      startedAt: oldState.started_at,
    })
  );


  // ==========================================================
  // ПЕРШИЙ ЗАПУСК
  // ==========================================================

  if (oldState === null) {
    // Якщо Worker запустився, коли тривога вже йде,
    // просто синхронізуємо стан без відправки повідомлення.
    await saveState(env, {
      active: isActive,
      started_at: isActive
        ? (alert?.since || new Date().toISOString())
        : null,
    });

    console.log(
      `Initial state saved. Active: ${isActive}`
    );

    return;
  }


  // ==========================================================
  // ТРИВОГА ПОЧАЛАСЯ
  // ==========================================================

  if (!oldState.active && isActive) {
    const startedAt =
      alert?.since || new Date().toISOString();

    await saveState(env, {
      active: true,
      started_at: startedAt,
    });

    await sendTelegram(
      env,
      `🚨 <b>ПОВІТРЯНА ТРИВОГА</b>

⚠️ Пройдіть в укриття та перебувайте там до офіційного відбою.

    );

    console.log("ALERT STARTED");

    return;
  }


  // ==========================================================
  // ТРИВОГА ТРИВАЄ
  // ==========================================================

  if (oldState.active && isActive) {
    // Нічого не робимо.
    //
    // yellow -> red
    // red -> yellow
    //
    // не створюють нових повідомлень.

    console.log("Alert is still active.");

    return;
  }


  // ==========================================================
  // ВІДБІЙ
  // ==========================================================

  if (oldState.active && !isActive) {
    const endedAt = new Date();
    const startedAt = oldState.started_at
      ? new Date(oldState.started_at)
      : null;

    const duration = startedAt
      ? formatDuration(endedAt - startedAt)
      : "невідомо";

    await saveState(env, {
      active: false,
      started_at: null,
    });

    await sendTelegram(
      env,
      `🟢 <b>ВІДБІЙ ПОВІТРЯНОЇ ТРИВОГИ</b>

⏱️ Небезпека тривала: <b>${duration}</b>

    );

    console.log(
      `ALERT ENDED. Duration: ${duration}`
    );

    return;
  }
}


// ============================================================
// KV STATE
// ============================================================

async function getState(env) {
  const raw = await env.ALERT_STATE.get(STATE_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid state in KV:", error);
    return null;
  }
}


async function saveState(env, state) {
  await env.ALERT_STATE.put(
    STATE_KEY,
    JSON.stringify(state)
  );
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram API error: ${JSON.stringify(result)}`
    );
  }

  return result;
}


// ============================================================
// ФОРМАТУВАННЯ ТРИВАЛОСТІ
// ============================================================

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "невідомо";
  }

  const totalMinutes = Math.floor(
    milliseconds / 60_000
  );

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} хв`;
  }

  if (minutes === 0) {
    return `${hours} год`;
  }

  return `${hours} год ${minutes} хв`;
}


// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
