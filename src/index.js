const BROVARY_RAION_UID = "79";
const KV_KEY = "brovary_alert_state";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
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


// =====================================================
// ПЕРЕВІРКА ALERTS.IN.UA
// =====================================================

async function checkAlerts(env) {
  try {
    if (!env.ALERTS_API_TOKEN) {
      throw new Error("ALERTS_API_TOKEN не налаштований");
    }

    if (!env.BROVARY_ALERT_KV) {
      throw new Error("BROVARY_ALERT_KV не підключений");
    }

    // Отримуємо активні тривоги
    const response = await fetch(
      "https://api.alerts.in.ua/v1/alerts/active.json",
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${env.ALERTS_API_TOKEN}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      return {
        ok: false,
        api_status: response.status,
        error: errorText || "Alerts.in.ua API error"
      };
    }

    const data = await response.json();

    const alerts = Array.isArray(data.alerts)
      ? data.alerts
      : [];

    // =================================================
    // ТІЛЬКИ UID 79
    // =================================================

    const brovaryAlerts = alerts.filter(
      alert =>
        String(alert.location_uid) === BROVARY_RAION_UID &&
        alert.alert_type === "air_raid"
    );

    // Якщо одночасно прийде декілька записів,
    // беремо перший повітряний alert
    const currentAlert = brovaryAlerts[0] || null;

    // =================================================
    // ПОПЕРЕДНІЙ СТАН
    // =================================================

    const saved =
      await env.BROVARY_ALERT_KV.get(
        KV_KEY,
        "json"
      );


    // =================================================
    // НЕМАЄ АКТИВНОЇ ТРИВОГИ
    // =================================================

    if (!currentAlert) {

      // Якщо раніше тривога була активною
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
            finishedAt: finishedAt.toISOString()
          })
        );

        return {
          ok: true,
          state: "finished",
          duration,
          startedAt: saved.startedAt,
          finishedAt: finishedAt.toISOString()
        };
      }

      return {
        ok: true,
        state: "no_alert"
      };
    }


    // =================================================
    // Є АКТИВНА ТРИВОГА
    // =================================================

    const level =
      currentAlert.alert_level === "red"
        ? "red"
        : "yellow";


    // =================================================
    // ЧАС ПОЧАТКУ
    // =================================================

    /*
      Alerts.in.ua передає started_at.
      Саме його використовуємо для початку всієї
      тривоги.

      Якщо з якихось причин started_at відсутній,
      беремо поточний час.
    */

    const apiStartedAt =
      currentAlert.started_at ||
      new Date().toISOString();


    // =================================================
    // НОВА ТРИВОГА
    // =================================================

    if (!saved || !saved.active) {

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,
        JSON.stringify({
          active: true,
          level: level,
          startedAt: apiStartedAt
        })
      );


      // НОВА ЧЕРВОНА
      if (level === "red") {

        await sendTelegram(
          env,
          `🔴 <b>ЧЕРВОНА ТРИВОГА</b>`
        );

      }

      // НОВА ЖОВТА
      else {

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


    // =================================================
    // ЗМІНА РІВНЯ ТРИВОГИ
    // =================================================

    if (saved.level !== level) {

      /*
        ВАЖЛИВО:

        startedAt НЕ змінюємо.

        Наприклад:

        19:00 — жовта
        19:30 — червона
        20:00 — жовта
        20:10 — відбій

        Тривалість буде рахуватися
        від 19:00 до 20:10.
      */

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,
        JSON.stringify({
          ...saved,
          active: true,
          level: level
        })
      );


      // =================================================
      // ЖОВТА → ЧЕРВОНА
      // =================================================

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


      // =================================================
      // ЧЕРВОНА → ЖОВТА
      // =================================================

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


    // =================================================
    // ТРИВОГА ПРОДОВЖУЄТЬСЯ
    // =================================================

    return {
      ok: true,
      state: "active",
      level: level,
      startedAt: saved.startedAt
    };


  } catch (error) {

    return {
      ok: false,
      error: error.message
    };

  }
}


// =====================================================
// TELEGRAM
// =====================================================

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


  const telegramUrl =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;


  const response = await fetch(
    telegramUrl,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    }
  );


  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Telegram API ${response.status}: ${errorText}`
    );
  }
}


// =====================================================
// ФОРМАТУВАННЯ ТРИВАЛОСТІ
// =====================================================

function formatDuration(ms) {

  if (!Number.isFinite(ms) || ms < 0) {
    return "невідомо";
  }


  const totalSeconds =
    Math.floor(ms / 1000);


  const hours =
    Math.floor(
      totalSeconds / 3600
    );


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


  /*
    Секунди показуємо тільки якщо
    тривога менше хвилини.

    Тобто:

    10 сек
    1 хв
    1 год 10 хв
  */

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
