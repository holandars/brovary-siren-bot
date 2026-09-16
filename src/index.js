export default {
  async fetch(request, env) {
    try {
      const response = await fetch(
        "https://api.alerts.in.ua/v1/alerts/active.json",
        {
          headers: {
            "Authorization": `Bearer ${env.ALERTS_API_TOKEN}`
          }
        }
      );

      const text = await response.text();

      return new Response(
        JSON.stringify({
          alerts_api_status: response.status,
          alerts_api_ok: response.ok,
          response: text
        }, null, 2),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );

    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error.message
        }, null, 2),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }
  }
};
