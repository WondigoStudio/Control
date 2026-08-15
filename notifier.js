const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO;
// Адрес отправителя. По умолчанию используем тестовый домен Resend —
// он работает без верификации собственного домена.
const NOTIFY_EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || 'Status Monitor <onboarding@resend.dev>';

// Часовой пояс для времени внутри уведомлений (Telegram/email). Без этого
// new Date().toLocaleString() берёт системный часовой пояс СЕРВЕРА
// (на большинстве хостингов — UTC), а не пояс пользователя, из-за чего
// время в уведомлениях "кардинально отличается" от реального.
// Задаётся в .env, например: NOTIFY_TZ=Asia/Almaty
const NOTIFY_TZ = process.env.NOTIFY_TZ || 'UTC';

// Единая точка форматирования времени для всех текстов уведомлений —
// checker.js, trendDetection.js, inactivityReport.js и сам notifier.js
// должны использовать именно её, а не голый new Date().toLocaleString().
function formatNotifyTime(ts) {
  return new Date(ts ?? Date.now()).toLocaleString('ru-RU', { timeZone: NOTIFY_TZ });
}

function formatNotifyTimeShort(ts) {
  return new Date(ts ?? Date.now()).toLocaleTimeString('ru-RU', {
    timeZone: NOTIFY_TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Определяем тип уведомления по эмодзи в начале subject — так уже
// помечены все вызовы notify() по коду (🔴 недоступен, ✅ восстановлен,
// ⚠️ предупреждение), переиспользуем это как единственный источник
// правды для цвета, а не дублируем классификацию в каждом checker.js.
function resolveTheme(subject) {
  if (subject.startsWith('🔴')) return { color: '#dc2626', bg: '#fef2f2', label: 'Инцидент' };
  if (subject.startsWith('✅')) return { color: '#16a34a', bg: '#f0fdf4', label: 'Восстановлено' };
  if (subject.startsWith('⚠️')) return { color: '#d97706', bg: '#fffbeb', label: 'Предупреждение' };
  return { color: '#2563eb', bg: '#eff6ff', label: 'Уведомление' };
}

// Строки таких блоков (Evidence, почасовой тренд latency) выравнены по
// смыслу как таблица — при обычном обтекании текста это разваливается.
// Опознаём их по префиксам, которые сами же генерируем в diagnosticProbe.js
// / trendDetection.js, и рендерим моноширинным блоком, а не абзацем.
const MONOSPACE_LINE = /^(DNS|TCP|TLS|HTTP|Other locations|Hosting|Conclusion|Recovery|Action|Evidence)\s*:|^\s*(US|DE|SG)\s*:|^\d{1,2}:\d{2}(:\d{2})?\s/;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderBody(text) {
  const blocks = text.split('\n\n');
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const isMonospace = lines.filter((l) => MONOSPACE_LINE.test(l.trim())).length >= 2;
      if (isMonospace) {
        return `<pre style="margin:0 0 16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:13px;line-height:1.6;color:#334155;white-space:pre-wrap;">${escapeHtml(block)}</pre>`;
      }
      return `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function renderEmailHtml(subject, text) {
  const theme = resolveTheme(subject);
  const title = escapeHtml(subject.replace(/^[^\wа-яА-Я]+/u, '').trim() || subject);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <div style="background:${theme.bg};border-bottom:3px solid ${theme.color};padding:18px 24px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${theme.color};margin-bottom:4px;">${theme.label}</div>
      <div style="font-size:17px;font-weight:600;color:#0f172a;">${title}</div>
    </div>
    <div style="padding:20px 24px;">
      ${renderBody(text)}
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
      Control · ${formatNotifyTime()}
    </div>
  </div>
</body>
</html>`;
}

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
        html: renderEmailHtml(subject, text),
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

module.exports = { notify, formatNotifyTime, formatNotifyTimeShort };
