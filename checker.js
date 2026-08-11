const fetch = require('node-fetch');
const tls = require('tls');
const { URL } = require('url');
const { insertCheck, getState, setState, setSSLStatus, getSSLStatus } = require('./db');
const { notify } = require('./notifier');
const { timingFetch } = require('./timingFetch');

function checkSSLCert(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ valid: false, error: 'Не удалось получить сертификат' });
          return;
        }
        const expiresAt = new Date(cert.valid_to).getTime();
        const daysLeft = Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        resolve({ valid: daysLeft > 0, expiresAt, daysLeft });
      }
    );
    socket.on('error', (e) => resolve({ valid: false, error: e.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ valid: false, error: 'Таймаут подключения' });
    });
  });
}

async function runSSLCheck(monitor) {
  if (monitor.type !== 'http' || !monitor.url || !monitor.url.startsWith('https://')) return;
  try {
    const hostname = new URL(monitor.url).hostname;
    const result = await checkSSLCert(hostname);
    setSSLStatus(monitor.id, result.valid, result.expiresAt, result.daysLeft, result.error);

    if (result.valid && result.daysLeft <= 14) {
      const prev = getSSLStatus(monitor.id);
      const alreadyWarned = prev && prev.days_left !== null && prev.days_left <= 14;
      if (!alreadyWarned) {
        await notify(
          `⚠️ SSL-сертификат ${monitor.name} скоро истекает`,
          `Сертификат для "${monitor.name}" (${hostname}) истекает через ${result.daysLeft} дн.\nПродли сертификат заранее, чтобы избежать падения сайта.`
        );
      }
    }
  } catch (e) {
    setSSLStatus(monitor.id, false, null, null, e.message);
  }
}

async function checkHttp(monitor) {
  const start = Date.now();
  try {
    const res = await timingFetch(monitor.url, { timeoutMs: monitor.timeoutMs || 8000 });
    const responseMs = Date.now() - start;
    const expected = monitor.expectedStatus || 200;
    const statusOk = res.statusCode === expected || (Array.isArray(expected) ? expected.includes(res.statusCode) : res.statusCode < 400);

    let contentOk = null;
    if (monitor.expectedContent) {
      contentOk = res.body.includes(monitor.expectedContent);
    }

    const ok = statusOk && (contentOk === null || contentOk === true);
    let error = null;
    if (!statusOk) error = `Unexpected status ${res.statusCode}`;
    else if (contentOk === false) error = `Ожидаемый текст "${monitor.expectedContent}" не найден на странице`;

    return {
      ok,
      responseMs,
      statusCode: res.statusCode,
      error,
      headers: {
        server: res.headers['server'] || null,
        'content-type': res.headers['content-type'] || null,
        'content-length': res.headers['content-length'] || null,
      },
      contentOk,
      timing: res.timing,
    };
  } catch (e) {
    return { ok: false, responseMs: Date.now() - start, statusCode: null, error: e.message, headers: null, contentOk: null, timing: null };
  }
}

async function checkTelegramBot(monitor) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), monitor.timeoutMs || 8000);
    const res = await fetch(`https://api.telegram.org/bot${monitor.botToken}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
    const responseMs = Date.now() - start;
    const data = await res.json();
    const ok = res.ok && data.ok === true;
    return { ok, responseMs, statusCode: res.status, error: ok ? null : (data.description || 'Bot check failed') };
  } catch (e) {
    return { ok: false, responseMs: Date.now() - start, statusCode: null, error: e.message };
  }
}

async function runCheck(monitor) {
  let result;
  if (monitor.type === 'telegram_bot') {
    result = await checkTelegramBot(monitor);
  } else {
    result = await checkHttp(monitor);
  }

  insertCheck(monitor.id, result.ok, result.responseMs, result.statusCode, result.error, result.headers, result.contentOk, result.timing);

  const lastSSL = getSSLStatus(monitor.id);
  if (!lastSSL || Date.now() - lastSSL.checked_at > 24 * 60 * 60 * 1000) {
    runSSLCheck(monitor).catch(() => {});
  }

  const prevState = getState(monitor.id);
  const newStatus = result.ok ? 'up' : 'down';

  if (!prevState || prevState.last_status !== newStatus) {
    setState(monitor.id, newStatus);
    if (prevState) {
      if (newStatus === 'down') {
        await notify(
          `🔴 ${monitor.name} недоступен`,
          `Монитор "${monitor.name}" стал недоступен.\n\nОшибка: ${result.error || 'нет ответа'}\nВремя: ${new Date().toLocaleString('ru-RU')}`
        );
      } else {
        await notify(
          `🟢 ${monitor.name} снова доступен`,
          `Монитор "${monitor.name}" восстановился.\n\nВремя отклика: ${result.responseMs} мс\nВремя: ${new Date().toLocaleString('ru-RU')}`
        );
      }
    }
  }

  return result;
}

module.exports = { runCheck };
