const ALERT_API = "https://neptun.in.ua/api/v1/alerts";

const DISTRICT_KEY = "броварський";
const STATE_KEY = "brovary_alert_state";

const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;

// Практичний захист від паралельних запусків Cron.
// KV-lock не є 100% атомарним mutex.
const LOCK_KEY = "brovary_alert_worker_lock";
const LOCK_TTL_SECONDS = 90;

const TELEGRAM_CHAT_ID = "@brovary_tryvoha";


// ============================================================
// WORKER
// ============================================================

export default {
  async scheduled(event, env, ctx) {
    await runChecks(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------------------------------------------
    // /test — тест Telegram
    // --------------------------------------------------------

    if (url.pathname === "/test") {
      try {
        await sendTelegram(
          env,
          `🧪 <b>ТЕСТ БОТА</b>

Бот працює коректно.`
        );

        return new Response("Test message sent", {
          status: 200,
        });
      } catch (error) {
        console.error("Test error:", error);

        return new Response(
          `Telegram error: ${error.message}`,
          { status: 500 }
        );
      }
    }


    // --------------------------------------------------------
    // /check — ручна перевірка стану
    // --------------------------------------------------------

    if (url.pathname === "/check") {
      try {
        await checkAlert(env);

        return new Response("Check completed", {
          status: 200,
        });
      } catch (error) {
        console.error("Check error:", error);

        return new Response(
          `Check error: ${error.message}`,
          { status: 500 }
        );
      }
    }


    return new Response(
      "Brovary alert worker is running."
    );
  },
};


// ============================================================
// ОСНОВНИЙ ЦИКЛ
// ============================================================

async function runChecks(env) {
  const lockId = crypto.randomUUID();

  // Перевіряємо, чи вже працює інший запуск
  const existingLock = await env.ALERT_STATE.get(LOCK_KEY);

  if (existingLock) {
    console.log(
      "Another worker run is already active."
    );

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
      console.log(
        `Alert check ${i + 1}/${CHECKS_PER_RUN}`
      );

      try {
        await checkAlert(env);
      } catch (error) {
        console.error(
          "Alert check failed:",
          error
        );
      }

      // Пауза між перевірками
      if (i < CHECKS_PER_RUN - 1) {
        await sleep(CHECK_INTERVAL_MS);
      }
    }
  } finally {
    // Видаляємо lock тільки якщо він наш
    const currentLock =
      await env.ALERT_STATE.get(LOCK_KEY);

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

  // ==========================================================
  // ГОЛОВНА ЛОГІКА
  // ==========================================================
  //
  // Нам НЕ важливо:
  // yellow
  // red
  // reasons
  //
  // Нас цікавить тільки:
  //
  // Є Броварський район у raions → ТРИВОГА
  // Немає Броварського району → ВІДБОЮ
  //
  // ==========================================================

  const alert = (data.raions || []).find(
    item => item.key === DISTRICT_KEY
  );

  const isActive = Boolean(alert);

  const oldState = await getState(env);

  console.log(
    "Current state:",
    oldState
  );

  console.log(
    "Current alert:",
    isActive
  );


  // ==========================================================
  // ПЕРШИЙ ЗАПУСК
  // ==========================================================

  if (oldState === null) {
    // Якщо Worker стартував, коли тривога вже активна,
    // просто запам'ятовуємо її стан.
    //
    // Повідомлення НЕ відправляємо,
    // щоб після перезапуску не було помилкового
    // повідомлення про початок тривоги.

    await saveState(env, {
      active: isActive,
      started_at: isActive
        ? (
            alert?.since ||
            new Date().toISOString()
          )
        : null,
    });

    console.log(
      `Initial state saved. Active: ${isActive}`
    );

    return;
  }


  // ==========================================================
  // ПОЧАТОК ТРИВОГИ
  // ==========================================================

  if (!oldState.active && isActive) {
    const startedAt =
      alert?.since ||
      new Date().toISOString();

    await sendTelegram(
      env,
      `🔴 <b>ПОВІТРЯНА ТРИВОГА</b>

⚠️ Пройдіть в укриття та перебувайте там до офіційного відбою.`
    );

    // Зберігаємо стан після успішної відправки
    await saveState(env, {
      active: true,
      started_at: startedAt,
    });

    console.log("ALERT STARTED");

    return;
  }


  // ==========================================================
  // ТРИВОГА ПРОДОВЖУЄТЬСЯ
  // ==========================================================

  if (oldState.active && isActive) {
    // Нічого не відправляємо.
    //
    // yellow → red    = нічого
    // red → yellow    = нічого
    // yellow → yellow = нічого
    // red → red       = нічого

    console.log(
      "Alert is still active."
    );

    return;
  }


  // ==========================================================
  // ВІДБІЙ ТРИВОГИ
  // ==========================================================

  if (oldState.active && !isActive) {
    const endedAt = new Date();

    const startedAt = oldState.started_at
      ? new Date(oldState.started_at)
      : null;

    const duration = startedAt
      ? formatDuration(
          endedAt.getTime() -
          startedAt.getTime()
        )
      : "невідомо";

    await sendTelegram(
      env,
      `🟢 <b>ВІДБІЙ ПОВІТРЯНОЇ ТРИВОГИ</b>

⏱️ Небезпека тривала: <b>${duration}</b>`
    );

    // Після успішної відправки
    // переводимо стан у "тривоги немає"
    await saveState(env, {
      active: false,
      started_at: null,
    });

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
  const raw = await env.ALERT_STATE.get(
    STATE_KEY
  );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(
      "Invalid state in KV:",
      error
    );

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
    throw new Error(
      "BOT_TOKEN is not configured"
    );
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
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    return "невідомо";
  }

  const totalMinutes = Math.floor(
    milliseconds / 60_000
  );

  const hours = Math.floor(
    totalMinutes / 60
  );

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
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}
