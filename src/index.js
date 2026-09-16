const BROVARY_RAION_UID = "79";
const KV_KEY = "brovary_alert_state";

const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;

const ALERTS_API_URL =
  "https://api.alerts.in.ua/v1/alerts/active.json";

export default {
  async scheduled(event, env, ctx) {
    await runChecks(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Ручна перевірка:
    // https://твій-worker.workers.dev/check
    if (url.pathname === "/check") {
      const result = await checkAlerts(env);

      return new Response(
        JSON.stringify(result, null, 2),
        {
          status: result.ok ? 200 : 500,
          headers: {
            "Content-Type":
              "application/json; charset=utf-8"
          }
        }
      );
    }

    return new Response(
      "Brovary siren bot is running.",
      {
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};


/*
==================================================
6 ПЕРЕВІРОК НА ОДИН CRON-ЗАПУСК
Кожна перевірка через 10 секунд
==================================================
*/

async function runChecks(env) {
  for (let i = 0; i < CHECKS_PER_RUN; i++) {

    const now =
      new Date().toISOString();

    console.log(
      `[${now}] ALERT CHECK ${i + 1}/${CHECKS_PER_RUN}`
    );

    try {
      const result =
        await checkAlerts(env);

      console.log(
        `[${new Date().toISOString()}] CHECK RESULT ${JSON.stringify(result)}`
      );

    } catch (error) {

      console.error(
        `CHECK_ERROR message=${getErrorMessage(error)}`
      );

    }

    if (i < CHECKS_PER_RUN - 1) {
      await sleep(CHECK_INTERVAL_MS);
    }
  }
}


/*
==================================================
ОСНОВНА ПЕРЕВІРКА ALERTS.IN.UA
==================================================
*/

async function checkAlerts(env) {

  try {

    console.log(
      `[${new Date().toISOString()}] START ALERTS API`
    );


    /*
    -------------------------------
    Перевірка Secrets / KV
    -------------------------------
    */

    if (!env.ALERTS_API_TOKEN) {
      throw new Error(
        "ALERTS_API_TOKEN не налаштований"
      );
    }

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

    if (!env.BROVARY_ALERT_KV) {
      throw new Error(
        "BROVARY_ALERT_KV не підключений"
      );
    }


    /*
    -------------------------------
    Запит до Alerts.in.ua
    -------------------------------
    */

    const response =
      await fetch(
        ALERTS_API_URL,
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


    /*
    -------------------------------
    Читаємо відповідь
    -------------------------------
    */

    const responseText =
      await response.text();


    console.log(
      `[${new Date().toISOString()}] ALERTS HTTP STATUS=${response.status}`
    );

    console.log(
      `[${new Date().toISOString()}] ALERTS RESPONSE LENGTH=${responseText.length}`
    );


    /*
    -------------------------------
    Помилка API
    -------------------------------
    */

    if (!response.ok) {

      console.error(
        `ALERTS_API_ERROR status=${response.status} body=${responseText}`
      );

      return {
        ok: false,
        source: "alerts.in.ua",
        status: response.status,
        error: responseText
      };
    }


    /*
    -------------------------------
    JSON
    -------------------------------
    */

    let data;

    try {

      data =
        JSON.parse(responseText);

    } catch (error) {

      console.error(
        `JSON_PARSE_ERROR message=${getErrorMessage(error)}`
      );

      console.error(
        `RAW_API_RESPONSE=${responseText}`
      );

      return {
        ok: false,
        error:
          "Alerts.in.ua повернув некоректний JSON"
      };
    }


    /*
    -------------------------------
    Масив активних тривог
    -------------------------------
    */

    const alerts =
      Array.isArray(data.alerts)
        ? data.alerts
        : [];


    console.log(
      `[${new Date().toISOString()}] TOTAL_ACTIVE_ALERTS=${alerts.length}`
    );


    /*
    -------------------------------
    Шукаємо Броварський район
    -------------------------------
    */

    const brovaryAlerts =
      alerts.filter(
        alert =>
          String(alert.location_uid) ===
            BROVARY_RAION_UID &&

          alert.alert_type ===
            "air_raid"
      );


    console.log(
      `[${new Date().toISOString()}] BROVARY_ALERTS=${brovaryAlerts.length}`
    );


    const currentAlert =
      brovaryAlerts[0] || null;


    /*
    -------------------------------
    Читаємо попередній стан з KV
    -------------------------------
    */

    const saved =
      await env.BROVARY_ALERT_KV.get(
        KV_KEY,
        "json"
      );


    console.log(
      `[${new Date().toISOString()}] SAVED_STATE=${JSON.stringify(saved)}`
    );


    /*
    ==================================================
    НЕМАЄ АКТИВНОЇ ТРИВОГИ
    ==================================================
    */

    if (!currentAlert) {

      /*
      Якщо раніше тривога була активна —
      це відбій
      */

      if (
        saved &&
        saved.active
      ) {

        const startedAt =
          new Date(
            saved.startedAt
          );

        const finishedAt =
          new Date();

        const durationMs =
          finishedAt.getTime() -
          startedAt.getTime();

        const duration =
          formatDuration(
            durationMs
          );


        console.log(
          `[${new Date().toISOString()}] ALERT FINISHED duration=${duration}`
        );


        /*
        Telegram
        */

        await sendTelegram(
          env,

          `🟢 <b>ВІДБІЙ ТРИВОГИ</b>\n\n` +
          `⏱ Тривалість: <b>${duration}</b>`
        );


        /*
        Оновлюємо KV
        */

        await env.BROVARY_ALERT_KV.put(
          KV_KEY,

          JSON.stringify({
            active: false,

            level:
              saved.level,

            startedAt:
              saved.startedAt,

            finishedAt:
              finishedAt.toISOString()
          })
        );


        return {
          ok: true,

          state:
            "finished",

          duration,

          startedAt:
            saved.startedAt,

          finishedAt:
            finishedAt.toISOString()
        };
      }


      /*
      Тривоги немає і раніше
      теж не було
      */

      return {
        ok: true,

        state:
          "no_alert"
      };
    }


    /*
    ==================================================
    Є АКТИВНА ТРИВОГА
    ==================================================
    */

    const level =
      currentAlert.alert_level === "red"
        ? "red"
        : "yellow";


    const apiStartedAt =
      currentAlert.started_at ||
      new Date().toISOString();


    console.log(
      `[${new Date().toISOString()}] ACTIVE ALERT level=${level} started=${apiStartedAt}`
    );


    /*
    ==================================================
    НОВА ТРИВОГА
    ==================================================
    */

    if (
      !saved ||
      !saved.active
    ) {

      console.log(
        `[${new Date().toISOString()}] NEW ALERT`
      );


      /*
      Зберігаємо стан
      */

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,

        JSON.stringify({
          active: true,

          level:
            level,

          startedAt:
            apiStartedAt
        })
      );


      /*
      Telegram
      */

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

        state:
          "started",

        level,

        startedAt:
          apiStartedAt
      };
    }


    /*
    ==================================================
    ЗМІНА РІВНЯ
    ==================================================
    */

    if (
      saved.level !== level
    ) {

      console.log(
        `[${new Date().toISOString()}] LEVEL CHANGED ${saved.level} -> ${level}`
      );


      await env.BROVARY_ALERT_KV.put(
        KV_KEY,

        JSON.stringify({
          ...saved,

          active: true,

          level:
            level
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

        state:
          "level_changed",

        from:
          saved.level,

        to:
          level,

        startedAt:
          saved.startedAt
      };
    }


    /*
    ==================================================
    ТРИВОГА ПРОДОВЖУЄТЬСЯ
    ==================================================
    */

    return {
      ok: true,

      state:
        "active",

      level,

      startedAt:
        saved.startedAt
    };


  } catch (error) {

    const message =
      getErrorMessage(error);

    const stack =
      String(
        error?.stack ||
        "no stack"
      );


    /*
    ВАЖЛИВО:
    один console.error = один рядок.
    Так Cloudflare Observability
    не губить message.
    */

    console.error(
      `CHECK_ERROR message=${message} stack=${stack}`
    );


    return {
      ok: false,

      state:
        "error",

      error:
        message
    };
  }
}


/*
==================================================
TELEGRAM
==================================================
*/

async function sendTelegram(
  env,
  message
) {

  console.log(
    `[${new Date().toISOString()}] TELEGRAM SEND`
  );


  const telegramUrl =
    `https://api.telegram.org/bot` +
    `${env.BOT_TOKEN}` +
    `/sendMessage`;


  const response =
    await fetch(
      telegramUrl,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id:
              env.CHAT_ID,

            text:
              message,

            parse_mode:
              "HTML",

            disable_web_page_preview:
              true
          })
      }
    );


  const responseText =
    await response.text();


  console.log(
    `[${new Date().toISOString()}] TELEGRAM HTTP STATUS=${response.status}`
  );


  if (!response.ok) {

    console.error(
      `TELEGRAM_API_ERROR status=${response.status} body=${responseText}`
    );

    throw new Error(
      `Telegram API ${response.status}: ${responseText}`
    );
  }


  console.log(
    `[${new Date().toISOString()}] TELEGRAM OK`
  );
}


/*
==================================================
ПОМИЛКА
==================================================
*/

function getErrorMessage(
  error
) {

  if (
    error instanceof Error
  ) {
    return (
      error.message ||
      error.toString()
    );
  }


  if (
    typeof error ===
    "string"
  ) {
    return error;
  }


  try {

    return JSON.stringify(
      error
    );

  } catch {

    return String(error);
  }
}


/*
==================================================
ФОРМАТУВАННЯ ТРИВАЛОСТІ
==================================================
*/

function formatDuration(
  ms
) {

  if (
    !Number.isFinite(ms) ||
    ms < 0
  ) {
    return "невідомо";
  }


  const totalSeconds =
    Math.floor(
      ms / 1000
    );


  const hours =
    Math.floor(
      totalSeconds / 3600
    );


  const minutes =
    Math.floor(
      (totalSeconds % 3600) /
      60
    );


  const seconds =
    totalSeconds % 60;


  const result = [];


  if (hours > 0) {
    result.push(
      `${hours} год`
    );
  }


  if (minutes > 0) {
    result.push(
      `${minutes} хв`
    );
  }


  if (
    result.length === 0 &&
    seconds > 0
  ) {
    result.push(
      `${seconds} сек`
    );
  }


  if (
    result.length === 0
  ) {
    result.push(
      "0 сек"
    );
  }


  return result.join(" ");
}


/*
==================================================
SLEEP
==================================================
*/

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}
