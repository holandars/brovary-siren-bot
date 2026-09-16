const BROVARY_RAION_UID = "79";
const KV_KEY = "brovary_alert_state";

const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;

export default {
  async scheduled(event, env, ctx) {
    await runChecks(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      const result = await checkAlerts(env);

      return new Response(
        JSON.stringify(result, null, 2),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }

    return new Response(
      "Alerts monitor is running.",
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};

async function runChecks(env) {
  for (let i = 0; i < CHECKS_PER_RUN; i++) {
    console.log(
      `[${new Date().toISOString()}] Alert check ${i + 1}/${CHECKS_PER_RUN}`
    );

    try {
      await checkAlerts(env);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] CHECK ERROR: ${getErrorMessage(error)}`
      );
    }

    if (i < CHECKS_PER_RUN - 1) {
      await sleep(CHECK_INTERVAL_MS);
    }
  }
}

async function checkAlerts(env) {
  try {
    console.log(
      `[${new Date().toISOString()}] Starting Alerts.in.ua request`
    );

    if (!env.ALERTS_API_TOKEN) {
      throw new Error(
        "ALERTS_API_TOKEN не налаштований"
      );
    }

    if (!env.BROVARY_ALERT_KV) {
      throw new Error(
        "BROVARY_ALERT_KV не підключений"
      );
    }

    const response = await fetch(
      "https://api.alerts.in.ua/v1/alerts/active.json",
      {
        method: "GET",
        headers: {
          "Authorization":
            `Bearer ${env.ALERTS_API_TOKEN}`,
          "Accept":
            "application/json"
        }
      }
    );

    const responseText = await response.text();

    console.log(
      `[${new Date().toISOString()}] Alerts.in.ua HTTP ${response.status}`
    );

    if (!response.ok) {
      console.error(
        `[${new Date().toISOString()}] Alerts.in.ua ERROR BODY: ${responseText}`
      );

      return {
        ok: false,
        api_status: response.status,
        error:
          responseText ||
          "Alerts.in.ua API error"
      };
    }

    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] JSON PARSE ERROR: ${getErrorMessage(error)}`
      );

      console.error(
        `[${new Date().toISOString()}] RAW API RESPONSE: ${responseText}`
      );

      return {
        ok: false,
        error: "Alerts.in.ua повернув некоректний JSON"
      };
    }

    const alerts =
      Array.isArray(data.alerts)
        ? data.alerts
        : [];

    console.log(
      `[${new Date().toISOString()}] Total active alerts: ${alerts.length}`
    );

    const brovaryAlerts =
      alerts.filter(
        alert =>
          String(alert.location_uid) === BROVARY_RAION_UID &&
          alert.alert_type === "air_raid"
      );

    console.log(
      `[${new Date().toISOString()}] Brovary matching alerts: ${brovaryAlerts.length}`
    );

    const currentAlert =
      brovaryAlerts[0] || null;

    const saved =
      await env.BROVARY_ALERT_KV.get(
        KV_KEY,
        "json"
      );

    console.log(
      `[${new Date().toISOString()}] Saved state: ${JSON.stringify(saved)}`
    );

    /*
     * Немає активної тривоги
     */
    if (!currentAlert) {
      if (saved && saved.active) {
        const startedAt =
          new Date(saved.startedAt);

        const finishedAt =
          new Date();

        const durationMs =
          finishedAt.getTime() -
          startedAt.getTime();

        const duration =
          formatDuration(durationMs);

        console.log(
          `[${new Date().toISOString()}] ALERT FINISHED. Duration: ${duration}`
        );

        await sendTelegram(
          env,
          `🟢 <b>ВІДБІЙ ТРИВОГИ</b>\n\n` +
          `⏱ Тривалість: <b>${duration}</b>`
        );

        await env.BROVARY_ALERT_KV.put(
          KV_KEY,
          JSON.stringify({
            active: false,
            level: saved.level,
            startedAt: saved.startedAt,
            finishedAt:
              finishedAt.toISOString()
          })
        );

        return {
          ok: true,
          state: "finished",
          duration,
          startedAt: saved.startedAt,
          finishedAt:
            finishedAt.toISOString()
        };
      }

      return {
        ok: true,
        state: "no_alert"
      };
    }

    /*
     * Є активна тривога
     */
    const level =
      currentAlert.alert_level === "red"
        ? "red"
        : "yellow";

    const apiStartedAt =
      currentAlert.started_at ||
      new Date().toISOString();

    console.log(
      `[${new Date().toISOString()}] CURRENT ALERT: level=${level}, started_at=${apiStartedAt}`
    );

    /*
     * Нова тривога
     */
    if (!saved || !saved.active) {
      console.log(
        `[${new Date().toISOString()}] NEW ALERT DETECTED`
      );

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,
        JSON.stringify({
          active: true,
          level: level,
          startedAt: apiStartedAt
        })
      );

      if (level === "red") {
        await sendTelegram(
          env,
          `🔴 <b>ЧЕРВОНА ТРИВОГА</b>`
        );
      } else {
        await sendTelegram(
          env,
          `🟡 <b>ЖОВТА ТРИВОГА</b>`
        );
      }

      return {
        ok: true,
        state: "started",
        level: level,
        startedAt: apiStartedAt
      };
    }

    /*
     * Зміна рівня
     */
    if (saved.level !== level) {
      console.log(
        `[${new Date().toISOString()}] ALERT LEVEL CHANGED: ${saved.level} -> ${level}`
      );

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,
        JSON.stringify({
          ...saved,
          active: true,
          level: level
        })
      );

      if (level === "red") {
        await sendTelegram(
          env,
          `🔴 <b>ЧЕРВОНА ТРИВОГА</b>`
        );

        return {
          ok: true,
          state: "level_changed",
          from: saved.level,
          to: "red",
          startedAt: saved.startedAt
        };
      }

      if (level === "yellow") {
        await sendTelegram(
          env,
          `🟡 <b>ЖОВТА ТРИВОГА</b>`
        );

        return {
          ok: true,
          state: "level_changed",
          from: saved.level,
          to: "yellow",
          startedAt: saved.startedAt
        };
      }
    }

    return {
      ok: true,
      state: "active",
      level: level,
      startedAt: saved.startedAt
    };

  } catch (error) {
    const message =
      getErrorMessage(error);

    console.error(
      `[${new Date().toISOString()}] CHECK ALERTS ERROR: ${message}`
    );

    if (error && error.stack) {
      console.error(
        `[${new Date().toISOString()}] STACK: ${error.stack}`
      );
    }

    return {
      ok: false,
      error: message
    };
  }
}

async function sendTelegram(env, message) {
  if (!env.BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN не налаштований"
    );
  }

  if (!env.CHAT_ID) {
    throw new Error(
      "CHAT_ID не налаштований"
    );
  }

  console.log(
    `[${new Date().toISOString()}] Sending Telegram message`
  );

  const telegramUrl =
    `https://api.telegram.org/bot` +
    `${env.BOT_TOKEN}/sendMessage`;

  const response = await fetch(
    telegramUrl,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    }
  );

  const responseText =
    await response.text();

  console.log(
    `[${new Date().toISOString()}] Telegram HTTP ${response.status}`
  );

  if (!response.ok) {
    console.error(
      `[${new Date().toISOString()}] Telegram ERROR BODY: ${responseText}`
    );

    throw new Error(
      `Telegram API ${response.status}: ${responseText}`
    );
  }
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.toString();
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatDuration(ms) {
  if (
    !Number.isFinite(ms) ||
    ms < 0
  ) {
    return "невідомо";
  }

  const totalSeconds =
    Math.floor(ms / 1000);

  const hours =
    Math.floor(totalSeconds / 3600);

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const seconds =
    totalSeconds % 60;

  const result = [];

  if (hours > 0) {
    result.push(`${hours} год`);
  }

  if (minutes > 0) {
    result.push(`${minutes} хв`);
  }

  if (
    result.length === 0 &&
    seconds > 0
  ) {
    result.push(`${seconds} сек`);
  }

  if (result.length === 0) {
    result.push("0 сек");
  }

  return result.join(" ");
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}
