const ALERT_API =
  "https://tryvoha.online/api/v1/alerts";

const DISTRICT_SLUG = "brovarskii-raion";
const STATE_KEY = "brovary_alert_state";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ТЕСТ ОТПРАВКИ СООБЩЕНИЯ В TELEGRAM
    if (url.pathname === "/test") {
      try {
        await sendTelegram(
          env,
          `🧪 <b>ТЕСТ БОТА</b>\n\n` +
          `📍 Бровари та Броварський район\n` +
          `🤖 Telegram-бот работает правильно!`
        );

        return new Response(
          "Тестовое сообщение отправлено ✅"
        );
      } catch (error) {
        console.log("TEST ERROR:", error);

        return new Response(
          `Ошибка отправки в Telegram ❌\n\n${error.message}`,
          { status: 500 }
        );
      }
    }

    return new Response(
      "Бровари Тривога — бот работает ✅"
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlert(env));
  },
};


async function checkAlert(env) {
  try {
    const response = await fetch(ALERT_API, {
      headers: {
        "User-Agent": "Brovary-Siren-Bot/1.0",
      },
    });

    if (!response.ok) {
      console.log(
        "API error:",
        response.status
      );

      return;
    }

    const data = await response.json();

    const alert = (data.alerts || []).find(
      (item) =>
        item.slug === DISTRICT_SLUG
    );

    const isActive = Boolean(alert);

    const oldStateRaw =
      await env.ALERT_STATE.get(STATE_KEY);

    // ПЕРВЫЙ ЗАПУСК
    if (!oldStateRaw) {
      await env.ALERT_STATE.put(
        STATE_KEY,
        JSON.stringify({
          active: isActive,
          started_at:
            alert?.started_at || null,
        })
      );

      console.log(
        "Initial state saved:",
        isActive
      );

      return;
    }

    const oldState =
      JSON.parse(oldStateRaw);


    // НАЧАЛО ТРЕВОГИ
    if (
      !oldState.active &&
      isActive
    ) {
      const startedAt =
        alert.started_at ||
        new Date().toISOString();

      await env.ALERT_STATE.put(
        STATE_KEY,
        JSON.stringify({
          active: true,
          started_at: startedAt,
        })
      );

      const time =
        formatKyivTime(startedAt);

      await sendTelegram(
        env,
        `🚨 <b>ПОВІТРЯНА ТРИВОГА</b>\n\n` +

        `⚠️ Пройдіть в укриття та перебувайте там до офіційного відбою.`
      );

      console.log(
        "ALERT START:",
        startedAt
      );

      return;
    }


    // ОТБОЙ ТРЕВОГИ
    if (
      oldState.active &&
      !isActive
    ) {
      const startedAt =
        oldState.started_at;

      const finishedAt =
        new Date();

      let duration =
        "невідомо";

      if (startedAt) {
        const start =
          new Date(startedAt);

        const minutes =
          Math.max(
            0,
            Math.round(
              (finishedAt - start) /
                60000
            )
          );

        const hours =
          Math.floor(
            minutes / 60
          );

        const mins =
          minutes % 60;

        if (hours > 0) {
          duration =
            `${hours} год ${mins} хв`;
        } else {
          duration =
            `${mins} хв`;
        }
      }

      const endTime =
        formatKyivTime(
          finishedAt.toISOString()
        );

      await env.ALERT_STATE.put(
        STATE_KEY,
        JSON.stringify({
          active: false,
          started_at: null,
        })
      );

      await sendTelegram(
        env,
        `🟢 <b>ВІДБІЙ ПОВІТРЯНОЇ ТРИВОГИ</b>\n\n` +
        
        `⏱ Тривалість: <b>${duration}</b>\n\n`
      );

      console.log(
        "ALERT END:",
        endTime
      );

      return;
    }


    console.log(
      "No change. Active:",
      isActive
    );

  } catch (error) {
    console.log(
      "Worker error:",
      error
    );
  }
}


async function sendTelegram(
  env,
  text
) {
  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        chat_id:
          "@brovary_siren",

        text: text,

        parse_mode:
          "HTML",

        disable_web_page_preview:
          true,
      }),
    });

  const result =
    await response.text();

  console.log(
    "Telegram:",
    response.status,
    result
  );

  if (!response.ok) {
    throw new Error(
      `Telegram error ${response.status}: ${result}`
    );
  }
}


function formatKyivTime(
  isoString
) {
  return new Intl.DateTimeFormat(
    "uk-UA",
    {
      timeZone:
        "Europe/Kyiv",

      hour: "2-digit",

      minute: "2-digit",

      hour12: false,
    }
  ).format(
    new Date(isoString)
  );
}
