const fetch = require('node-fetch');
const tls = require('tls');
const { URL } = require('url');
const { insertCheck, getState, updateMonitorState, markRestartAttempted, logRestartAttempt, setSSLStatus, getSSLStatus, saveMultiLocationResult, incrementRecoveryAttempts, markRecoveryExhaustedNotified, countRecentRestarts, openIncident, incrementIncidentChecks, closeIncident, markIncidentNotified, markIncidentRecovery } = require('./db');
const { notify } = require('./notifier');
const { detectSuspensionSignature, diagnose } = require('./diagnosis');
const { checkMultiLocation } = require('./multiLocationCheck');
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
    await setSSLStatus(monitor.id, result.valid, result.expiresAt, result.daysLeft, result.error);

    if (result.valid && result.daysLeft <= 14) {
      const prev = await getSSLStatus(monitor.id);
      const alreadyWarned = prev && prev.days_left !== null && prev.days_left <= 14;
      if (!alreadyWarned) {
        await notify(
          `⚠️ SSL-сертификат ${monitor.name} скоро истекает`,
          `Сертификат для "${monitor.name}" (${hostname}) истекает через ${result.daysLeft} дн.\nПродли сертификат заранее, чтобы избежать падения сайта.`
        );
      }
    }
  } catch (e) {
    await setSSLStatus(monitor.id, false, null, null, e.message);
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

    const suspensionMatch = detectSuspensionSignature(res.body);

    let botHealth = null;
    if (monitor.url.includes('/health')) {
      try {
        const parsed = JSON.parse(res.body);
        if (parsed && typeof parsed === 'object' && 'status' in parsed) {
          botHealth = {
            status: parsed.status,
            uptimeSec: parsed.uptime ?? null,
            version: parsed.version ?? null,
          };
        }
      } catch (e) {
        // не JSON — просто не бот-health-эндпоинт, работаем как с обычным сайтом
      }
    }

    const ok = statusOk && (contentOk === null || contentOk === true) && !suspensionMatch;
    let error = null;
    if (suspensionMatch) error = `SUSPENSION_PAGE_DETECTED: ${suspensionMatch}`;
    else if (!statusOk) error = `Unexpected status ${res.statusCode}`;
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
      botHealth,
    };
  } catch (e) {
    return { ok: false, responseMs: Date.now() - start, statusCode: null, error: e.message, headers: null, contentOk: null, timing: null, botHealth: null };
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

// --- Recovery Providers ---
const UNMANAGED_HOSTINGS = ['infinityfree', 'hidden_cloud'];

function resolveRecovery(monitor) {
  if (monitor.recovery) {
    return {
      provider: monitor.recovery.provider || 'none',
      enabled: monitor.recovery.enabled !== false,
      afterFails: monitor.recovery.afterFails || 3,
      deployHookUrl: monitor.recovery.deployHookUrl || monitor.deployHookUrl,
      maxAttempts: monitor.recovery.maxAttempts || 2,
      retryAfterFails: monitor.recovery.retryAfterFails || 10,
      maxPerHour: monitor.recovery.maxPerHour || 5,
    };
  }
  if (monitor.deployHookUrl) {
    return {
      provider: 'render',
      enabled: true,
      afterFails: monitor.restartAfterFails || 3,
      deployHookUrl: monitor.deployHookUrl,
      maxAttempts: 2,
      retryAfterFails: 10,
      maxPerHour: 5,
    };
  }
  if (monitor.hosting && UNMANAGED_HOSTINGS.includes(monitor.hosting)) {
    return { provider: 'none', enabled: true, afterFails: 3, deployHookUrl: null, maxAttempts: 0, retryAfterFails: 0, maxPerHour: 0, reason: `Хостинг "${monitor.hosting}" не предоставляет API для автоматического восстановления` };
  }
  return { provider: 'none', enabled: true, afterFails: 3, deployHookUrl: null, maxAttempts: 0, retryAfterFails: 0, maxPerHour: 0 };
}

async function runRecovery(monitor, recovery, attemptNumber, incidentId) {
  switch (recovery.provider) {
    case 'render':
      if (!recovery.deployHookUrl) {
        console.error(`[Recovery] provider "render" для "${monitor.name}" без deployHookUrl — пропускаю`);
        return;
      }
      await restartViaRenderHook(monitor, recovery.deployHookUrl, attemptNumber, recovery.maxAttempts, incidentId);
      return;

    case 'docker':
    case 'systemd':
    case 'pm2':
    case 'custom':
      console.log(`[Recovery] provider "${recovery.provider}" для "${monitor.name}" ещё не поддерживается — нужен агент на сервере.`);
      await logRestartAttempt(monitor.id, false, `Provider "${recovery.provider}" not implemented yet`, incidentId);
      await markIncidentRecovery(incidentId, recovery.provider, 'not_implemented');
      return;

    case 'none':
    default:
      return;
  }
}

async function restartViaRenderHook(monitor, deployHookUrl, attemptNumber, maxAttempts, incidentId) {
  const attemptLabel = attemptNumber && maxAttempts ? ` (попытка ${attemptNumber}/${maxAttempts})` : '';
  try {
    const res = await fetch(deployHookUrl, { method: 'POST' });
    const ok = res.ok;
    await logRestartAttempt(monitor.id, ok, ok ? null : `HTTP ${res.status}`, incidentId);
    await markIncidentRecovery(incidentId, 'render', ok ? 'success' : 'failed');
    await notify(
      ok ? `🔁 Автоперезапуск${attemptLabel}: ${monitor.name}` : `⚠️ Не удалось перезапустить ${monitor.name}${attemptLabel}`,
      ok
        ? `Монитор "${monitor.name}" упал несколько проверок подряд. Отправлен запрос на автоперезапуск через Render deploy hook${attemptLabel}.\nВремя: ${new Date().toLocaleString('ru-RU')}`
        : `Попытка автоперезапуска "${monitor.name}"${attemptLabel} не удалась (HTTP ${res.status}).\nПроверь deploy hook вручную.`
    );
  } catch (e) {
    await logRestartAttempt(monitor.id, false, e.message, incidentId);
    await markIncidentRecovery(incidentId, 'render', 'failed');
    await notify(
      `⚠️ Не удалось перезапустить ${monitor.name}${attemptLabel}`,
      `Попытка автоперезапуска "${monitor.name}"${attemptLabel} завершилась ошибкой: ${e.message}`
    );
  }
}

async function runCheck(monitor) {
  let result;
  if (monitor.type === 'telegram_bot') {
    result = await checkTelegramBot(monitor);
  } else {
    result = await checkHttp(monitor);
  }

  await insertCheck(monitor.id, result.ok, result.responseMs, result.statusCode, result.error, result.headers, result.contentOk, result.timing, result.botHealth);

  const lastSSL = await getSSLStatus(monitor.id);
  if (!lastSSL || Date.now() - lastSSL.checked_at > 24 * 60 * 60 * 1000) {
    runSSLCheck(monitor).catch(() => {});
  }

  const prevState = await getState(monitor.id);
  const { newStatus, statusChanged, consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified } = await updateMonitorState(monitor.id, result.ok);

  // --- Incident lifecycle ---
  let currentIncidentId = null;
  if (newStatus === 'down') {
    if (statusChanged) {
      const d = diagnose({ error: result.error, statusCode: result.statusCode, responseMs: result.responseMs, timeoutMs: monitor.timeoutMs, hosting: monitor.hosting });
      currentIncidentId = await openIncident(monitor.id, Date.now(), d.category, d.label, d.explanation, d.suggestion, result.error);
    } else {
      currentIncidentId = prevState ? prevState.current_incident_id : null;
      await incrementIncidentChecks(currentIncidentId, result.error);
    }
  } else if (statusChanged && prevState && prevState.current_incident_id) {
    await closeIncident(monitor.id, prevState.current_incident_id, Date.now());
  }

  if (statusChanged && prevState) {
    if (newStatus === 'down') {
      await notify(
        `🔴 ${monitor.name} недоступен`,
        `Монитор "${monitor.name}" стал недоступен.\n\nОшибка: ${result.error || 'нет ответа'}\nВремя: ${new Date().toLocaleString('ru-RU')}`
      );
      await markIncidentNotified(currentIncidentId);
    } else {
      await notify(
        `🟢 ${monitor.name} снова доступен`,
        `Монитор "${monitor.name}" восстановился.\n\nВремя отклика: ${result.responseMs} мс\nВремя: ${new Date().toLocaleString('ru-RU')}`
      );
    }
  }

  // --- Recovery Policy ---
  const recovery = resolveRecovery(monitor);
  if (recovery.enabled && recovery.provider !== 'none' && newStatus === 'down') {
    const attemptsSoFar = recoveryAttempts;

    if (attemptsSoFar < recovery.maxAttempts) {
      const triggerAt = recovery.afterFails + attemptsSoFar * recovery.retryAfterFails;

      if (consecutiveFails === triggerAt) {
        const recentRestarts = await countRecentRestarts(monitor.id, Date.now() - 60 * 60 * 1000);

        if (recentRestarts >= recovery.maxPerHour) {
          if (!recoveryExhaustedNotified) {
            await markRecoveryExhaustedNotified(monitor.id);
            await notify(
              `🛑 Лимит автоперезапусков исчерпан: ${monitor.name}`,
              `Монитор "${monitor.name}" продолжает падать, но лимит автоперезапусков (${recovery.maxPerHour}/час) уже исчерпан — это защита от бесконечного цикла restart → crash → restart.\n\nТребуется ручное вмешательство.`
            );
          }
        } else {
          await incrementRecoveryAttempts(monitor.id);
          runRecovery(monitor, recovery, attemptsSoFar + 1, currentIncidentId).catch(() => {});
        }
      }
    } else if (!recoveryExhaustedNotified && consecutiveFails > recovery.afterFails + (recovery.maxAttempts - 1) * recovery.retryAfterFails) {
      await markRecoveryExhaustedNotified(monitor.id);
      await notify(
        `🛑 Автовосстановление не помогло: ${monitor.name}`,
        `Все ${recovery.maxAttempts} попыт(ки/ка) автоперезапуска для "${monitor.name}" исчерпаны, но монитор всё ещё недоступен.\n\nОшибка: ${result.error || 'нет ответа'}\n\nТребуется ручная проверка.`
      );
    }
  }

  if (
    recovery.provider === 'none' &&
    monitor.type === 'http' &&
    newStatus === 'down' &&
    consecutiveFails === recovery.afterFails &&
    !restartAttempted
  ) {
    await markRestartAttempted(monitor.id);
    runAutoDiagnostics(monitor).catch(() => {});
  }

  return result;
}

async function runAutoDiagnostics(monitor) {
  try {
    const results = await checkMultiLocation(monitor.url);
    await saveMultiLocationResult(monitor.id, results);

    const total = results.length;
    const downCount = results.filter((r) => r.ok === false).length;
    const upCount = results.filter((r) => r.ok === true).length;

    let verdict;
    if (downCount === total) {
      verdict = `Все ${total} проверенных локации подтверждают недоступность — это реальное падение, а не локальная проблема мониторинга.`;
    } else if (upCount === total) {
      verdict = `Все ${total} проверенных локации показывают, что сайт ДОСТУПЕН — возможно, это временный сбой именно нашего сервера-наблюдателя (Render), а не реальная проблема сайта.`;
    } else {
      verdict = `Смешанная картина: ${downCount} из ${total} локаций видят падение, ${upCount} — доступность. Может указывать на гео-специфичную проблему (например, блокировку в отдельных странах) или нестабильность.`;
    }

    const locationsList = results
      .map((r) => `${r.label}: ${r.ok === true ? `✓ доступен (${r.responseMs} мс)` : r.ok === false ? `✗ недоступен (${r.error || 'ошибка'})` : '— нет данных'}`)
      .join('\n');

    await notify(
      `🔍 Диагностика: ${monitor.name}`,
      `Автоматическая проверка из разных локаций для "${monitor.name}" (автовосстановление для этого хостинга недоступно).\n\n${verdict}\n\nПодробности по локациям:\n${locationsList}`
    );
  } catch (e) {
    console.error(`[AutoDiagnostics] Ошибка для ${monitor.id}:`, e.message);
  }
}

module.exports = { runCheck };
