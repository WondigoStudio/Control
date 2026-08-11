const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO;
// Адрес отправителя. По умолчанию используем тестовый домен Resend —
// он работает без верификации собственного домена.
const NOTIFY_EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || 'Status Monitor <onboarding@resend.dev>';

async function notify(subject, text) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_TO) {
    console.log('[notify] (Email не настроен) ' + subject + ' — ' + text);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_EMAIL_FROM,
        to: [NOTIFY_EMAIL_TO],
        subject,
        text,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[notify] Ошибка отправки email:', data.message || JSON.stringify(data));
      return;
    }

    console.log('[notify] Письмо отправлено, id:', data.id, '→', NOTIFY_EMAIL_TO);
  } catch (e) {
    console.error('[notify] Ошибка отправки email:', e.message);
  }
}

module.exports = { notify };
