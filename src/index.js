const BROVARY_RAION_UID = "79";

const KV_KEY = "brovary_alert_state";

const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;

const ALERTS_API_URL =
  "https://api.alerts.in.ua/v1/alerts/active.json";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      return Response.json(await checkAlerts(env));
    }

    return new Response(
      "Brovary Siren Bot is running.\nUse /check for diagnostics.",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      }
    );
  },
};

async function runChecks(env) {
  for (let i = 1; i <= CHECKS_PER_RUN; i++) {
    const started = Date.now();

    console.log(
      `[${new Date().toISOString()}] ALERT CHECK ${i}/${CHECKS_PER_RUN}`
    );

    try {
      const result = await checkAlerts(env);

      console.log(
        `[${new Date().toISOString()}] CHECK RESULT ${JSON.stringify(
          result
        )}`
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] CHECK_ERROR message=${getErrorMessage(
          error
        )} stack=${error?.stack || "no-stack"}`
      );
    }

    if (i < CHECKS_PER_RUN) {
      const elapsed = Date.now() - started;
      const waitTime = Math.max(0, CHECK_INTERVAL_MS - elapsed);

      await sleep(waitTime);
    }
  }
}

async function checkAlerts(env) {
  try {
    /*
     * Перевірка необхідних змінних
     */

    if (!env.ALERTS_API_TOKEN) {
      throw new Error("ALERTS_API_TOKEN не налаштований");
    }

    if (!env.BOT_TOKEN) {
      throw new Error("BOT_TOKEN не налаштований");
    }

    if (!env.CHAT_ID) {
      throw new Error("CHAT_ID не налаштований");
    }

    if (!env.ALERT_STATE) {
      throw new Error("ALERT_STATE не підключений");
    }

    /*
     * Запит до Alerts.in.ua
     */

    const response = await fetch(ALERTS_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.ALERTS_API_TOKEN}`,
        Accept: "application/json",
      },
    });

    const responseText = await response.text();

    console.log(
      `[${new Date().toISOString()}] ALERTS API HTTP ${response.status}, body length=${responseText.length}`
    );

    if (!response.ok) {
      throw new Error(
        `Alerts.in.ua HTTP ${response.status}: ${responseText.slice(0, 500)}`
      );
    }

    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      throw new Error(
        `Не вдалося розібрати JSON Alerts.in.ua: ${getErrorMessage(error)}`
      );
    }

    /*
     * Пошук активної повітряної тривоги
     * саме для Броварського району
     */

    const alerts = Array.isArray(data?.alerts)
      ? data.alerts
      : [];

    const brovaryAlert = alerts.find((alert) => {
      return (
        String(alert?.location_uid) === BROVARY_RAION_UID &&
        alert?.alert_type === "air_raid"
      );
    });

    /*
     * Отримуємо попередній стан
     */

    let saved = null;

    try {
      const savedText = await env.ALERT_STATE.get(KV_KEY);

      if (savedText) {
        saved = JSON.parse(savedText);
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] KV_READ_ERROR message=${getErrorMessage(
          error
        )}`
      );

      saved = null;
    }

    /*
     * Нормалізуємо старий/відсутній стан
     */

    if (!saved || typeof saved !== "object") {
      saved = {
        active: false,
        startedAt: null,
        level: null,
      };
    }

    /*
     * Якщо активної тривоги немає
     */

    if (!brovaryAlert) {
      if (saved.active) {
        const startedAt = saved.startedAt
          ? new Date(saved.startedAt)
          : null;

        const duration = startedAt
          ? formatDuration(Date.now() - startedAt.getTime())
          : null;

        await sendTelegram(
          env,
          `🟢 <b>ВІДБІЙ ТРИВОГИ</b>${
            duration ? `\n⏱ Тривалість: ${duration}` : ""
          }`
        );

        await env.ALERT_STATE.put(
          KV_KEY,
          JSON.stringify({
            active: false,
            startedAt: null,
            level: null,
          })
        );

        console.log(
          `[${new Date().toISOString()}] ALERT FINISHED`
        );

        return {
          ok: true,
          state: "finished",
          duration,
        };
      }

      return {
        ok: true,
        state: "no_alert",
      };
    }

    /*
     * Визначаємо рівень тривоги
     */

    const level =
      String(brovaryAlert.alert_level || "").toLowerCase();

    let telegramMessage;

    if (level === "red") {
      telegramMessage = "🔴 <b>ЧЕРВОНА ТРИВОГА</b>";
    } else {
      telegramMessage = "🟡 <b>ЖОВТА ТРИВОГА</b>";
    }

    /*
     * Нова тривога
     */

    if (!saved.active) {
      const startedAt =
        brovaryAlert.started_at ||
        new Date().toISOString();

      await sendTelegram(env, telegramMessage);

      await env.ALERT_STATE.put(
        KV_KEY,
        JSON.stringify({
          active: true,
          startedAt,
          level,
        })
      );

      console.log(
        `[${new Date().toISOString()}] NEW ALERT level=${level} startedAt=${startedAt}`
      );

      return {
        ok: true,
        state: "active",
        level,
        startedAt,
      };
    }

    /*
     * Рівень змінився під час активної тривоги
     */

    if (saved.level !== level) {
      await sendTelegram(env, telegramMessage);

      await env.ALERT_STATE.put(
        KV_KEY,
        JSON.stringify({
          active: true,
          startedAt:
            saved.startedAt ||
            brovaryAlert.started_at ||
            new Date().toISOString(),
          level,
        })
      );

      console.log(
        `[${new Date().toISOString()}] ALERT LEVEL CHANGED ${saved.level} -> ${level}`
      );

      return {
        ok: true,
        state: "level_changed",
        previousLevel: saved.level,
        level,
      };
    }

    /*
     * Тривога все ще активна
     */

    return {
      ok: true,
      state: "active",
      level,
      startedAt:
        saved.startedAt ||
        brovaryAlert.started_at ||
        null,
    };
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] CHECK_ERROR message=${getErrorMessage(
        error
      )} stack=${error?.stack || "no-stack"}`
    );

    return {
      ok: false,
      state: "error",
      error: getErrorMessage(error),
    };
  }
}

async function sendTelegram(env, message) {
  const telegramUrl =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const responseText = await response.text();

  console.log(
    `[${new Date().toISOString()}] TELEGRAM HTTP ${response.status}, body=${responseText.slice(
      0,
      500
    )}`
  );

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}: ${responseText.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Telegram повернув некоректний JSON: ${getErrorMessage(error)}`
    );
  }

  if (!data.ok) {
    throw new Error(
      `Telegram API error: ${data.description || "unknown error"}`
    );
  }

  return data;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }

  const totalSeconds = Math.floor(milliseconds / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];

  if (hours > 0) {
    parts.push(`${hours} год`);
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes} хв`);
  }

  parts.push(`${seconds} сек`);

  return parts.join(" ");
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Невідома помилка";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
