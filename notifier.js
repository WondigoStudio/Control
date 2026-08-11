const fetch = require('node-fetch');

const NOTIFY_BOT_TOKEN = process.env.NOTIFY_BOT_TOKEN; // токен бота, который шлёт уведомления
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;     // твой chat_id

async function notify(text) {
  if (!NOTIFY_BOT_TOKEN || !NOTIFY_CHAT_ID) {
    console.log('[notify] (Telegram не настроен) ' + text);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: NOTIFY_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    console.error('[notify] Ошибка отправки в Telegram:', e.message);
  }
}

module.exports = { notify };
