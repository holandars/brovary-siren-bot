const BROVARY_RAION_UID = "79";
const KV_KEY = "brovary_alert_state";

// =====================================================
// НАЛАШТУВАННЯ ШВИДКОСТІ
// =====================================================
//
// Cron запускає Worker 1 раз на хвилину.
//
// За один запуск Worker робимо 6 перевірок:
//
// 00 сек → перевірка
// 10 сек → перевірка
// 20 сек → перевірка
// 30 сек → перевірка
// 40 сек → перевірка
// 50 сек → перевірка
//
// Разом: 6 запитів / хвилину.
//
// Це нижче soft limit Alerts.in.ua:
// 8–10 запитів / хвилину.
//

const CHECKS_PER_RUN = 6;
const CHECK_INTERVAL_MS = 10_000;


// =====================================================
// CLOUDFLARE WORKER
// =====================================================

export default {

  // ---------------------------------------------------
  // CRON
  // ---------------------------------------------------

  async scheduled(event, env, ctx) {

    // scheduled() чекає завершення всього циклу.
    //
    // Один запуск триває приблизно 50 секунд:
    //
    // перевірка
    // ↓ 10 сек
    // перевірка
    // ↓ 10 сек
    // ...
    // ↓
    // остання перевірка

    await runChecks(env);
  },


  // ---------------------------------------------------
  // HTTP
  // ---------------------------------------------------

  async fetch(request, env) {

    const url = new URL(request.url);


    // =================================================
    // /check
    // =================================================
    //
    // Робить одну перевірку Alerts.in.ua.
    //
    // Зручно для ручного тестування.

    if (url.pathname === "/check") {

      const result =
        await checkAlerts(env);

      return new Response(
        JSON.stringify(
          result,
          null,
          2
        ),
        {
          headers: {
            "Content-Type":
              "application/json; charset=utf-8"
          }
        }
      );
    }


    // =================================================
    // ГОЛОВНА
    // =================================================

    return new Response(
      "Alerts monitor is running.",
      {
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};


// =====================================================
// ЦИКЛ ПЕРЕВІРОК
// =====================================================

async function runChecks(env) {

  for (
    let i = 0;
    i < CHECKS_PER_RUN;
    i++
  ) {

    console.log(
      `Alert check ${i + 1}/${CHECKS_PER_RUN}`
    );


    // -------------------------------------------------
    // Одна перевірка
    // -------------------------------------------------

    try {

      await checkAlerts(env);

    } catch (error) {

      // Помилка однієї перевірки
      // не повинна зупиняти весь цикл.

      console.error(
        "Alert check error:",
        error
      );
    }


    // -------------------------------------------------
    // Пауза 10 секунд
    // -------------------------------------------------
    //
    // Після останньої перевірки пауза не потрібна.

    if (
      i < CHECKS_PER_RUN - 1
    ) {

      await sleep(
        CHECK_INTERVAL_MS
      );
    }
  }
}


// =====================================================
// ПЕРЕВІРКА ALERTS.IN.UA
// =====================================================

async function checkAlerts(env) {

  try {

    // -------------------------------------------------
    // Перевірка Secrets / KV
    // -------------------------------------------------

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


    // -------------------------------------------------
    // ALERTS.IN.UA
    // -------------------------------------------------

    const response =
      await fetch(
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


    // -------------------------------------------------
    // API ERROR
    // -------------------------------------------------

    if (!response.ok) {

      const errorText =
        await response.text();


      console.error(
        `Alerts.in.ua HTTP ${response.status}:`,
        errorText
      );


      return {
        ok: false,

        api_status:
          response.status,

        error:
          errorText ||
          "Alerts.in.ua API error"
      };
    }


    // -------------------------------------------------
    // JSON
    // -------------------------------------------------

    const data =
      await response.json();


    const alerts =
      Array.isArray(data.alerts)
        ? data.alerts
        : [];


    // =================================================
    // ТІЛЬКИ БРОВАРСЬКИЙ РАЙОН
    // =================================================

    const brovaryAlerts =
      alerts.filter(
        alert =>
          String(
            alert.location_uid
          ) === BROVARY_RAION_UID &&

          alert.alert_type ===
            "air_raid"
      );


    // Якщо активна повітряна тривога —
    // беремо перший відповідний запис.

    const currentAlert =
      brovaryAlerts[0] || null;


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


      // ------------------------------------------------
      // Раніше тривога була активною
      // ------------------------------------------------

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


        // ----------------------------------------------
        // ВІДБІЙ
        // ----------------------------------------------

        await sendTelegram(
          env,

          `🟢 <b>ВІДБІЙ ТРИВОГИ</b>\n\n` +
          `⏱ Тривалість: <b>${duration}</b>`
        );


        // ----------------------------------------------
        // Зберігаємо новий стан
        // ----------------------------------------------

        await env.BROVARY_ALERT_KV.put(
          KV_KEY,

          JSON.stringify({
            active:
              false,

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

          duration:
            duration,

          startedAt:
            saved.startedAt,

          finishedAt:
            finishedAt.toISOString()
        };
      }


      // ------------------------------------------------
      // Тривоги немає і раніше її теж не було
      // ------------------------------------------------

      return {
        ok: true,

        state:
          "no_alert"
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

    const apiStartedAt =
      currentAlert.started_at ||
      new Date().toISOString();


    // =================================================
    // НОВА ТРИВОГА
    // =================================================

    if (
      !saved ||
      !saved.active
    ) {

      // ----------------------------------------------
      // Запам'ятовуємо початок
      // ----------------------------------------------

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,

        JSON.stringify({
          active:
            true,

          level:
            level,

          startedAt:
            apiStartedAt
        })
      );


      // ----------------------------------------------
      // ЧЕРВОНА
      // ----------------------------------------------

      if (
        level === "red"
      ) {

        await sendTelegram(
          env,

          `🔴 <b>ЧЕРВОНА ТРИВОГА</b>`
        );

      }


      // ----------------------------------------------
      // ЖОВТА
      // ----------------------------------------------

      else {

        await sendTelegram(
          env,

          `🟡 <b>ЖОВТА ТРИВОГА</b>`
        );
      }


      return {
        ok: true,

        state:
          "started",

        level:
          level,

        startedAt:
          apiStartedAt
      };
    }


    // =================================================
    // ЗМІНА РІВНЯ
    // =================================================

    if (
      saved.level !== level
    ) {


      // ------------------------------------------------
      // ВАЖЛИВО:
      //
      // startedAt НЕ змінюємо.
      //
      // Наприклад:
      //
      // 19:00 жовта
      // 19:30 червона
      // 20:00 жовта
      // 20:10 відбій
      //
      // Тривалість = 19:00 → 20:10.
      // ------------------------------------------------

      await env.BROVARY_ALERT_KV.put(
        KV_KEY,

        JSON.stringify({
          ...saved,

          active:
            true,

          level:
            level
        })
      );


      // ------------------------------------------------
      // ЖОВТА → ЧЕРВОНА
      // ------------------------------------------------

      if (
        level === "red"
      ) {

        await sendTelegram(
          env,

          `🔴 <b>ЧЕРВОНА ТРИВОГА</b>`
        );


        return {
          ok: true,

          state:
            "level_changed",

          from:
            saved.level,

          to:
            "red",

          startedAt:
            saved.startedAt
        };
      }


      // ------------------------------------------------
      // ЧЕРВОНА → ЖОВТА
      // ------------------------------------------------

      if (
        level === "yellow"
      ) {

        await sendTelegram(
          env,

          `🟡 <b>ЖОВТА ТРИВОГА</b>`
        );


        return {
          ok: true,

          state:
            "level_changed",

          from:
            saved.level,

          to:
            "yellow",

          startedAt:
            saved.startedAt
        };
      }
    }


    // =================================================
    // ТРИВОГА ПРОДОВЖУЄТЬСЯ
    // =================================================

    return {
      ok: true,

      state:
        "active",

      level:
        level,

      startedAt:
        saved.startedAt
    };


  } catch (error) {

    console.error(
      "checkAlerts error:",
      error
    );


    return {
      ok: false,

      error:
        error.message
    };
  }
}


// =====================================================
// TELEGRAM
// =====================================================

async function sendTelegram(
  env,
  message
) {

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
    `https://api.telegram.org/bot` +
    `${env.BOT_TOKEN}/sendMessage`;


  const response =
    await fetch(
      telegramUrl,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
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


  if (!response.ok) {

    const errorText =
      await response.text();


    throw new Error(
      `Telegram API ${response.status}: ` +
      `${errorText}`
    );
  }
}


// =====================================================
// ФОРМАТУВАННЯ ТРИВАЛОСТІ
// =====================================================

function formatDuration(ms) {

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
      (totalSeconds % 3600) / 60
    );


  const seconds =
    totalSeconds % 60;


  const result = [];


  if (
    hours > 0
  ) {

    result.push(
      `${hours} год`
    );
  }


  if (
    minutes > 0
  ) {

    result.push(
      `${minutes} хв`
    );
  }


  // Секунди показуємо,
  // якщо тривога менше хвилини.

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


// =====================================================
// ПАУЗА
// =====================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}
