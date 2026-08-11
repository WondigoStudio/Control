const fetch = require('node-fetch');
const { insertCheck, getState, setState } = require('./db');
const { notify } = require('./notifier');

async function checkHttp(monitor) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), monitor.timeoutMs || 8000);
    const res = await fetch(monitor.url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    const responseMs = Date.now() - start;
    const expected = monitor.expectedStatus || 200;
    const ok = res.status === expected || (Array.isArray(expected) ? expected.includes(res.status) : res.status < 400);
    return { ok, responseMs, statusCode: res.status, error: ok ? null : `Unexpected status ${res.status}` };
  } catch (e) {
    return { ok: false, responseMs: Date.now() - start, statusCode: null, error: e.message };
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

  insertCheck(monitor.id, result.ok, result.responseMs, result.statusCode, result.error);

  const prevState = getState(monitor.id);
  const newStatus = result.ok ? 'up' : 'down';

  if (!prevState || prevState.last_status !== newStatus) {
    setState(monitor.id, newStatus);
    // Уведомляем только если это реальное изменение состояния (не первая проверка при старте на "up")
    if (prevState) {
      if (newStatus === 'down') {
        await notify(`🔴 <b>${monitor.name}</b> недоступен!\nОшибка: ${result.error || 'нет ответа'}`);
      } else {
        await notify(`🟢 <b>${monitor.name}</b> снова доступен (${result.responseMs} мс)`);
      }
    } else {
      // первая проверка — просто фиксируем состояние без уведомления
    }
  }

  return result;
}

module.exports = { runCheck };
