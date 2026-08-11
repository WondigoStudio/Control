const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = process.env.SMTP_PORT || 465;
const SMTP_USER = process.env.SMTP_USER;       // твой email, с которого отправляются письма
const SMTP_PASS = process.env.SMTP_PASS;       // пароль приложения (не обычный пароль!)
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO; // куда слать уведомления (может совпадать с SMTP_USER)

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true для 465 (SSL), false для 587 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
  });
}

async function notify(subject, text) {
  if (!transporter || !NOTIFY_EMAIL_TO) {
    console.log('[notify] (Email не настроен) ' + subject + ' — ' + text);
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: `"Status Monitor" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL_TO,
      subject,
      text,
    });
    console.log('[notify] Письмо отправлено, messageId:', info.messageId, '→', NOTIFY_EMAIL_TO);
  } catch (e) {
    console.error('[notify] Ошибка отправки email:', e.message);
  }
}

module.exports = { notify };
