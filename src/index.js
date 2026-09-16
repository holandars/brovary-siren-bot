// ============================================================
// BROVARY AIR RAID ALERT BOT
// Cloudflare Worker + Alerts.in.ua + Telegram
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const ALERT_API =
  "https://api.alerts.in.ua/v1/alerts/active.json";

const DISTRICT_NAME =
  "Броварський район";

const DISTRICT_TYPE =
  "raion";

const ALERT_TYPE =
  "air_raid";

const STATE_KEY =
  "brovary_alert_state";

const TELEGRAM_CHAT_ID =
  "@brovary_tryvoha";

// Alerts.in.ua: soft limit 8–10 req/min.
// Використовуємо 10 запитів/хв = один запит кожні 6 секунд.
const CHECK_INTERVAL_MS =
  6000;

const CHECKS_PER_RUN =
  10;


// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {

  // ----------------------------------------------------------
  // HTTP
  // ----------------------------------------------------------

  async fetch(request, env) {

    const url =
      new URL(request.url);


    // --------------------------------------------------------
    // /test
    // --------------------------------------------------------

    if (url.pathname === "/test") {

      try {

        await sendTelegram(
          env,
          "🟢 Тестове повідомлення від бота."
        );

        return json({
          success: true,
          message:
            "Telegram повідомлення відправлено."
        });

      } catch (error) {

        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }


    // --------------------------------------------------------
    // /check
    //
    // ТІЛЬКИ діагностика.
    // НЕ відправляє Telegram.
    // НЕ змінює KV.
    // --------------------------------------------------------

    if (url.pathname === "/check") {

      try {

        const result =
          await debugCheck(env);

        return json(result);

      } catch (error) {

        console.error(
          "Debug check error:",
          error
        );

        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }


    // --------------------------------------------------------
    // /status
    //
    // Показує стан, який зберігається в KV.
    // --------------------------------------------------------

    if (url.pathname === "/status") {

      const state =
        await getState(env);

      return json({
        success: true,
        state
      });
    }


    // --------------------------------------------------------
    // DEFAULT
    // --------------------------------------------------------

    return new Response(
      "Brovary Alert Worker is running.",
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  },


  // ----------------------------------------------------------
  // CRON
  // ----------------------------------------------------------

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runChecks(env)
    );
  }

};


// ============================================================
// MAIN CHECK LOOP
// ============================================================

async function runChecks(env) {

  for (
    let i = 0;
    i < CHECKS_PER_RUN;
    i++
  ) {

    try {

      await checkAlert(env);

    } catch (error) {

      console.error(
        `Check ${i + 1} error:`,
        error
      );
    }


    // Не чекаємо після останньої перевірки.
    if (
      i <
      CHECKS_PER_RUN - 1
    ) {

      await sleep(
        CHECK_INTERVAL_MS
      );
    }
  }
}


// ============================================================
// ONE ALERT CHECK
// ============================================================

async function checkAlert(env) {

  const state =
    await getState(env);


  const headers =
    new Headers();

  headers.set(
    "Accept",
    "application/json"
  );

  headers.set(
    "Authorization",
    `Bearer ${env.ALERTS_API_TOKEN}`
  );

  headers.set(
    "User-Agent",
    "BrovaryAlertBot/1.0"
  );


  // ----------------------------------------------------------
  // Last-Modified cache
  // ----------------------------------------------------------

  if (
    state &&
    state.lastModified
  ) {

    headers.set(
      "If-Modified-Since",
      state.lastModified
    );
  }


  // ----------------------------------------------------------
  // REQUEST
  // ----------------------------------------------------------

  const response =
    await fetch(
      ALERT_API,
      {
        method: "GET",
        headers
      }
    );


  // ----------------------------------------------------------
  // 304
  // Дані не змінилися.
  // Нічого робити не потрібно.
  // ----------------------------------------------------------

  if (
    response.status === 304
  ) {

    console.log(
      "Alerts.in.ua: 304 Not Modified"
    );

    return {
      changed: false,
      reason: "not_modified"
    };
  }


  // ----------------------------------------------------------
  // API ERROR
  // ----------------------------------------------------------

  if (!response.ok) {

    const body =
      await response.text();

    console.error(
      "Alerts.in.ua error:",
      response.status,
      body
    );

    // KV НЕ змінюємо.
    return {
      changed: false,
      reason: "api_error",
      status: response.status
    };
  }


  // ----------------------------------------------------------
  // JSON
  // ----------------------------------------------------------

  const data =
    await response.json();


  if (
    !data ||
    !Array.isArray(data.alerts)
  ) {

    throw new Error(
      "Alerts.in.ua: unexpected API response"
    );
  }


  // ----------------------------------------------------------
  // Last-Modified
  // ----------------------------------------------------------

  const lastModified =
    response.headers.get(
      "Last-Modified"
    );


  // ----------------------------------------------------------
  // FIND BROVARY DISTRICT
  // ----------------------------------------------------------

  const districtAlert =
    data.alerts.find(
      item =>
        item?.location_type ===
          DISTRICT_TYPE &&

        item?.location_title ===
          DISTRICT_NAME &&

        item?.alert_type ===
          ALERT_TYPE
    );


  const active =
    Boolean(districtAlert);


  console.log(
    "Brovary district:",
    active
      ? "ACTIVE"
      : "NO ALERT"
  );


  // ----------------------------------------------------------
  // FIRST RUN
  //
  // Якщо KV ще порожня —
  // синхронізуємо стан без Telegram.
  // ----------------------------------------------------------

  if (!state) {

    await saveState(
      env,
      {
        active,
        startedAt:
          active &&
          districtAlert?.started_at
            ? districtAlert.started_at
            : null,
        lastModified
      }
    );

    console.log(
      "Initial state synchronized:",
      active
    );

    return {
      changed: false,
      reason: "initial_sync",
      active
    };
  }


  // ----------------------------------------------------------
  // ACTIVE -> ACTIVE
  // ----------------------------------------------------------

  if (
    state.active &&
    active
  ) {

    // Оновлюємо Last-Modified,
    // якщо API його надіслав.

    if (
      lastModified &&
      lastModified !==
        state.lastModified
    ) {

      await saveState(
        env,
        {
          ...state,
          lastModified
        }
      );
    }

    return {
      changed: false,
      reason: "alert_still_active"
    };
  }


  // ----------------------------------------------------------
  // NO ALERT -> NO ALERT
  // ----------------------------------------------------------

  if (
    !state.active &&
    !active
  ) {

    if (
      lastModified &&
      lastModified !==
        state.lastModified
    ) {

      await saveState(
        env,
        {
          ...state,
          lastModified
        }
      );
    }

    return {
      changed: false,
      reason: "no_alert"
    };
  }


  // ==========================================================
  // ALERT STARTED
  // ==========================================================

  if (
    !state.active &&
    active
  ) {

    const startedAt =
      districtAlert?.started_at ||
      new Date().toISOString();


    const message =
      [
        "🚨 <b>ПОВІТРЯНА ТРИВОГА</b>",
        "",
        "📍 <b>Броварський район</b>",
        "",
        `🕐 Початок: ${formatDateTime(startedAt)}`
      ].join("\n");


    // Спочатку Telegram.
    // Якщо Telegram не відправився —
    // стан НЕ переводимо в active.

    await sendTelegram(
      env,
      message
    );


    await saveState(
      env,
      {
        active: true,
        startedAt,
        lastModified
      }
    );


    console.log(
      "ALERT STARTED"
    );

    return {
      changed: true,
      event: "started"
    };
  }


  // ==========================================================
  // ALERT ENDED
  // ==========================================================

  if (
    state.active &&
    !active
  ) {

    const endedAt =
      new Date();


    let durationText =
      "невідомо";


    if (
      state.startedAt
    ) {

      durationText =
        formatDuration(
          endedAt.getTime() -
          new Date(
            state.startedAt
          ).getTime()
        );
    }


    const message =
      [
        "🟢 <b>ВІДБІЙ ПОВІТРЯНОЇ ТРИВОГИ</b>",
        "",
        "📍 <b>Броварський район</b>",
        "",
        `🕐 Відбій: ${formatDateTime(endedAt)}`,
        `⏱ Тривалість: ${durationText}`
      ].join("\n");


    await sendTelegram(
      env,
      message
    );


    await saveState(
      env,
      {
        active: false,
        startedAt: null,
        lastModified
      }
    );


    console.log(
      "ALERT ENDED"
    );


    return {
      changed: true,
      event: "ended"
    };
  }


  return {
    changed: false,
    reason: "unknown"
  };
}


// ============================================================
// DEBUG /check
//
// ВАЖЛИВО:
// - Telegram НЕ відправляє
// - KV НЕ змінює
// - тільки читає Alerts.in.ua
// ============================================================

async function debugCheck(env) {

  if (
    !env.ALERTS_API_TOKEN
  ) {

    throw new Error(
      "ALERTS_API_TOKEN is not configured"
    );
  }


  const response =
    await fetch(
      ALERT_API,
      {
        method: "GET",

        headers: {
          "Accept":
            "application/json",

          "Authorization":
            `Bearer ${env.ALERTS_API_TOKEN}`,

          "User-Agent":
            "BrovaryAlertBot/1.0"
        }
      }
    );


  const lastModified =
    response.headers.get(
      "Last-Modified"
    );


  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  if (!response.ok) {

    const body =
      await response.text();

    return {
      success: false,
      http_status:
        response.status,
      last_modified:
        lastModified,
      error:
        body
    };
  }


  // ----------------------------------------------------------
  // DATA
  // ----------------------------------------------------------

  const data =
    await response.json();


  if (
    !data ||
    !Array.isArray(data.alerts)
  ) {

    return {
      success: false,
      http_status:
        response.status,
      error:
        "Unexpected API response",
      response:
        data
    };
  }


  // ----------------------------------------------------------
  // BROVARY
  // ----------------------------------------------------------

  const districtAlert =
    data.alerts.find(
      item =>
        item?.location_type ===
          DISTRICT_TYPE &&

        item?.location_title ===
          DISTRICT_NAME
    );


  // ----------------------------------------------------------
  // AIR RAID
  // ----------------------------------------------------------

  const airRaid =
    data.alerts.find(
      item =>
        item?.location_type ===
          DISTRICT_TYPE &&

        item?.location_title ===
          DISTRICT_NAME &&

        item?.alert_type ===
          ALERT_TYPE
    );


  return {

    success: true,

    http_status:
      response.status,

    last_modified:
      lastModified,

    alerts_count:
      data.alerts.length,

    district_found:
      Boolean(districtAlert),

    air_raid_active:
      Boolean(airRaid),

    district:
      districtAlert
        ? {
            id:
              districtAlert.id,

            location_uid:
              districtAlert.location_uid,

            location_title:
              districtAlert.location_title,

            location_type:
              districtAlert.location_type,

            alert_type:
              districtAlert.alert_type,

            alert_level:
              districtAlert.alert_level,

            started_at:
              districtAlert.started_at,

            updated_at:
              districtAlert.updated_at,

            finished_at:
              districtAlert.finished_at,

            threats:
              districtAlert.threats || []
          }
        : null
  };
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(
  env,
  text
) {

  if (
    !env.BOT_TOKEN
  ) {

    throw new Error(
      "BOT_TOKEN is not configured"
    );
  }


  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;


  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,

          text,

          parse_mode:
            "HTML",

          disable_web_page_preview:
            true
        })
      }
    );


  if (!response.ok) {

    const body =
      await response.text();

    throw new Error(
      `Telegram API ${response.status}: ${body}`
    );
  }


  const result =
    await response.json();


  if (
    !result.ok
  ) {

    throw new Error(
      `Telegram error: ${JSON.stringify(result)}`
    );
  }


  return result;
}


// ============================================================
// KV
// ============================================================

async function getState(env) {

  if (
    !env.BROVARY_ALERT_KV
  ) {

    throw new Error(
      "BROVARY_ALERT_KV is not configured"
    );
  }


  return await env.BROVARY_ALERT_KV.get(
    STATE_KEY,
    {
      type: "json"
    }
  );
}


async function saveState(
  env,
  state
) {

  if (
    !env.BROVARY_ALERT_KV
  ) {

    throw new Error(
      "BROVARY_ALERT_KV is not configured"
    );
  }


  await env.BROVARY_ALERT_KV.put(
    STATE_KEY,
    JSON.stringify(state)
  );
}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


function formatDateTime(
  value
) {

  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return String(value);
  }


  return date.toLocaleString(
    "uk-UA",
    {
      timeZone:
        "Europe/Kyiv",

      year: "numeric",
      month: "2-digit",
      day: "2-digit",

      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  );
}


function formatDuration(
  milliseconds
) {

  const totalSeconds =
    Math.max(
      0,
      Math.floor(
        milliseconds / 1000
      )
    );


  const minutes =
    Math.floor(
      totalSeconds / 60
    );


  const hours =
    Math.floor(
      minutes / 60
    );


  const remainingMinutes =
    minutes % 60;


  if (
    hours > 0
  ) {

    if (
      remainingMinutes > 0
    ) {

      return `${hours} год ${remainingMinutes} хв`;

    }

    return `${hours} год`;
  }


  return `${minutes} хв`;
}
