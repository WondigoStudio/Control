const fetch = require('node-fetch');
const tls = require('tls');
const { URL } = require('url');
const { insertCheck, getState, updateMonitorState, markRestartAttempted, logRestartAttempt, setSSLStatus, getSSLStatus, saveMultiLocationResult, incrementRecoveryAttempts, markRecoveryExhaustedNotified, countRecentRestarts, getRestartLog, openIncident, saveIncidentEvidence, incrementIncidentChecks, closeIncident, markIncidentNotified, markIncidentRecovery, countRecentIncidents, markFlappingNotified, getRecentResponseSizes } = require('./db');
const { notify } = require('./notifier');
const { detectSuspensionSignature, diagnose } = require('./diagnosis');
const { checkMultiLocation } = require('./multiLocationCheck');
const { timingFetch } = require('./timingFetch');
const { runDiagnosticProbe, formatEvidenceBlock } = require('./diagnosticProbe');

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
      contentOk = res.body.toLowerCase().includes(monitor.expectedContent.toLowerCase());
    }

    // "Must NOT contain" — обобщение suspension-детектора под свои фразы,
    // например "Database error" или "Account suspended" для конкретного сайта.
    // Сравнение без учёта регистра, чтобы не приходилось гадать с большими/
    // маленькими буквами при вводе фраз.
    let forbiddenMatch = null;
    if (monitor.expectedContentAbsent) {
      const forbiddenList = Array.isArray(monitor.expectedContentAbsent)
        ? monitor.expectedContentAbsent
        : String(monitor.expectedContentAbsent).split(',').map((s) => s.trim()).filter(Boolean);
      const bodyLower = res.body.toLowerCase();
      for (const phrase of forbiddenList) {
        if (phrase && bodyLower.includes(phrase.toLowerCase())) {
          forbiddenMatch = phrase; // сохраняем оригинальное написание для читаемости в уведомлениях
          break;
        }
      }
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

    const ok = statusOk && (contentOk === null || contentOk === true) && !suspensionMatch && !forbiddenMatch;
    let error = null;
    if (suspensionMatch) error = `SUSPENSION_PAGE_DETECTED: ${suspensionMatch}`;
    else if (forbiddenMatch) error = `FORBIDDEN_CONTENT_DETECTED: ${forbiddenMatch}`;
    else if (!statusOk) error = `Unexpected status ${res.statusCode}`;
    else if (contentOk === false) error = `Ожидаемый текст "${monitor.expectedContent}" не найден на странице`;

    const responseSize = res.body ? Buffer.byteLength(res.body, 'utf-8') : null;

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
      responseSize,
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
      cooldownMinutes: monitor.recovery.cooldownMinutes || 10,
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
      cooldownMinutes: 10,
    };
  }
  if (monitor.hosting && UNMANAGED_HOSTINGS.includes(monitor.hosting)) {
    return { provider: 'none', enabled: true, afterFails: 3, deployHookUrl: null, maxAttempts: 0, retryAfterFails: 0, maxPerHour: 0, cooldownMinutes: 0, reason: `Хостинг "${monitor.hosting}" не предоставляет API для автоматического восстановления` };
  }
  return { provider: 'none', enabled: true, afterFails: 3, deployHookUrl: null, maxAttempts: 0, retryAfterFails: 0, maxPerHour: 0, cooldownMinutes: 0 };
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

    case 'pm2':
    case 'systemd':
    case 'docker':
    case 'custom':
      // VPS Agent пока не развёрнут — эти провайдеры честно заглушки,
      // ничего не перезапускают, только фиксируют попытку.
      console.log(`[Recovery] provider "${recovery.provider}" для "${monitor.name}" ещё не поддерживается (VPS Agent не подключён).`);
      await logRestartAttempt(monitor.id, false, `Provider "${recovery.provider}" not implemented yet (VPS Agent not connected)`, incidentId);
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

  // --- Response Size Anomaly ---
  // Информационная метка, НЕ влияет на статус up/down — сознательное решение,
  // чтобы не трогать бинарную модель успех/падение лишний раз. Сравниваем
  // размер тела ответа с диапазоном по последним УСПЕШНЫМ проверкам.
  // Нужна минимальная история (10 успешных проверок), иначе на свежем
  // мониторе первая же проверка считалась бы "аномалией" сама с собой.
  let sizeAnomaly = false;
  if (result.ok && result.responseSize !== null && result.responseSize !== undefined) {
    const recentSizes = await getRecentResponseSizes(monitor.id, 30);
    if (recentSizes.length >= 10) {
      const avg = recentSizes.reduce((a, b) => a + b, 0) / recentSizes.length;
      const variance = recentSizes.reduce((a, b) => a + (b - avg) ** 2, 0) / recentSizes.length;
      const stddev = Math.sqrt(variance);
      // Порог: либо статистически значимое отклонение (3 стандартных отклонения),
      // либо просто большая относительная разница (30%) — что больше, то и используем.
      // Это защищает от гиперчувствительности, когда размер обычно почти не меняется.
      const threshold = Math.max(3 * stddev, avg * 0.3);
      sizeAnomaly = Math.abs(result.responseSize - avg) > threshold && threshold > 0;
    }
  }

  await insertCheck(monitor.id, result.ok, result.responseMs, result.statusCode, result.error, result.headers, result.contentOk, result.timing, result.botHealth, result.responseSize, sizeAnomaly);

  const lastSSL = await getSSLStatus(monitor.id);
  if (!lastSSL || Date.now() - lastSSL.checked_at > 24 * 60 * 60 * 1000) {
    runSSLCheck(monitor).catch(() => {});
  }

  // --- Maintenance Mode ---
  // Если монитор в обслуживании — проверка всё равно выполняется и пишется
  // в историю (для целостности графиков), но инциденты, уведомления и
  // автовосстановление не запускаются. Это специально для ситуации
  // "сам делаю деплой → не хочу, чтобы мониторинг мешал перезапусками".
  // Срок истёк сам по себе учитывается на лету — отдельно снимать флаг
  // в БД не нужно, при следующем открытии UI он уже посчитается как выключенный.
  const inMaintenance = !!(
    monitor.maintenance &&
    monitor.maintenance.enabled &&
    (!monitor.maintenance.until || Date.now() < monitor.maintenance.until)
  );

  const prevState = await getState(monitor.id);
  const { newStatus, statusChanged, consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified } = await updateMonitorState(monitor.id, result.ok);

  if (inMaintenance) {
    return result;
  }

  // Диагноз считаем один раз на каждую проверку в статусе "down" — используется
  // и для инцидента, и для решения, стоит ли вообще пытаться восстановить.
  const currentDiagnosis = newStatus === 'down'
    ? diagnose({ error: result.error, statusCode: result.statusCode, responseMs: result.responseMs, timeoutMs: monitor.timeoutMs, hosting: monitor.hosting })
    : null;

  // Считаем заранее (а не только внутри блока Recovery Policy ниже), чтобы
  // использовать в Evidence-уведомлении: пользователь должен видеть
  // "Recovery: NOT AVAILABLE" в том же сообщении, где падение объясняется,
  // а не только когда порог afterFails уже пройден.
  const RECOVERY_ALLOWED_CATEGORIES = ['TIMEOUT', 'HOSTING_PROBLEM', 'CONNECTION_REFUSED', 'CONTENT_MISMATCH', 'UNKNOWN'];
  const recoveryAllowedByCategory = !currentDiagnosis || RECOVERY_ALLOWED_CATEGORIES.includes(currentDiagnosis.category);
  const recovery = resolveRecovery(monitor);
  const recoveryStatusLabel = recovery.provider === 'none'
    ? (recovery.reason ? `NOT AVAILABLE (${recovery.reason})` : 'NOT AVAILABLE')
    : !recoveryAllowedByCategory
    ? 'NOT ATTEMPTED (причина не лечится перезапуском)'
    : `AVAILABLE (${recovery.provider})`;

  // --- Incident lifecycle ---
  let currentIncidentId = null;
  let currentEvidence = null;
  if (newStatus === 'down') {
    if (statusChanged) {
      currentIncidentId = await openIncident(monitor.id, Date.now(), currentDiagnosis.category, currentDiagnosis.label, currentDiagnosis.explanation, currentDiagnosis.suggestion, result.error);

      // Пошаговое расследование (DNS/TCP/TLS/HTTP) — только при открытии
      // инцидента, только для http-мониторов. Дорогая операция (до 3 доп.
      // round-trip'ов), поэтому не гоняем её на каждый тик, только один раз
      // на факт падения.
      if (monitor.type === 'http') {
        try {
          currentEvidence = await runDiagnosticProbe(monitor.url, monitor.timeoutMs || 8000);
          await saveIncidentEvidence(currentIncidentId, currentEvidence);
        } catch (e) {
          console.error(`[DiagnosticProbe] Ошибка для ${monitor.id}:`, e.message);
        }
      }
    } else {
      currentIncidentId = prevState ? prevState.current_incident_id : null;
      await incrementIncidentChecks(currentIncidentId, result.error);
    }
  } else if (statusChanged && prevState && prevState.current_incident_id) {
    await closeIncident(monitor.id, prevState.current_incident_id, Date.now());
  }

  // --- Flapping detection ---
  // Использует уже существующую таблицу инцидентов — просто считает, сколько
  // отдельных падений было у монитора за последнее окно времени. Если сервис
  // не столько "упал", сколько мечется между up/down — обычные уведомления
  // о каждом отдельном падении только шумят, толку от них немного.
  const flapping = {
    enabled: !monitor.flapping || monitor.flapping.enabled !== false,
    windowMinutes: (monitor.flapping && monitor.flapping.windowMinutes) || 10,
    threshold: (monitor.flapping && monitor.flapping.threshold) || 3,
  };
  let isFlapping = false;
  let recentIncidentsCount = 0;
  if (newStatus === 'down' && statusChanged && flapping.enabled) {
    const windowMs = flapping.windowMinutes * 60 * 1000;
    recentIncidentsCount = await countRecentIncidents(monitor.id, Date.now() - windowMs);
    isFlapping = recentIncidentsCount >= flapping.threshold;
  }

  if (statusChanged && prevState) {
    if (newStatus === 'down') {
      if (isFlapping) {
        const windowMs = flapping.windowMinutes * 60 * 1000;
        const lastFlapNotified = prevState.last_flapping_notified_ts || 0;
        if (Date.now() - lastFlapNotified > windowMs) {
          await markFlappingNotified(monitor.id);
          await notify(
            `⚠️ ${monitor.name} нестабилен (flapping)`,
            `Монитор "${monitor.name}" переключился между "работает" и "недоступен" ${recentIncidentsCount} раз за последние ${flapping.windowMinutes} минут.\n\nЭто похоже на нестабильность сервиса, а не единичное падение. Обычные уведомления о каждом отдельном падении временно не отправляются, пока флаппинг продолжается — чтобы не заваливать почту.`
          );
        }
        // при флаппинге обычное "упал" не шлём — только сводное уведомление выше
      } else {
        let evidenceText = '';
        if (currentEvidence) {
          evidenceText = '\n\n' + formatEvidenceBlock(currentEvidence, {
            hosting: monitor.hosting || null,
            conclusion: currentDiagnosis ? currentDiagnosis.label : null,
            recoveryStatus: recoveryStatusLabel,
            action: 'Notification sent',
          });
        }
        await notify(
          `🔴 ${monitor.name} недоступен`,
          `Монитор "${monitor.name}" стал недоступен.\n\nОшибка: ${result.error || 'нет ответа'}\nВремя: ${new Date().toLocaleString('ru-RU')}${evidenceText}`
        );
      }
      await markIncidentNotified(currentIncidentId);
    } else {
      await notify(
        `🟢 ${monitor.name} снова доступен`,
        `Монитор "${monitor.name}" восстановился.\n\nВремя отклика: ${result.responseMs} мс\nВремя: ${new Date().toLocaleString('ru-RU')}`
      );
    }
  }

  // --- Recovery Policy ---
  // (recoveryAllowedByCategory считается выше, вместе с currentDiagnosis —
  // не всякая причина падения означает, что перезапуск поможет: при
  // DNS_PROBLEM, SSL_PROBLEM или SUSPENDED restart процесса бессмыслен,
  // проблема не в самом процессе.)
  if (recovery.enabled && recovery.provider !== 'none' && newStatus === 'down') {
    const attemptsSoFar = recoveryAttempts;

    if (!recoveryAllowedByCategory) {
      // Причина падения не из тех, что лечатся перезапуском — сообщаем один раз
      // при первом достижении порога и больше не пытаемся restart на этом падении.
      if (attemptsSoFar === 0 && consecutiveFails === recovery.afterFails) {
        await notify(
          `ℹ️ Автовосстановление пропущено: ${monitor.name}`,
          `Монитор "${monitor.name}" недоступен по причине "${currentDiagnosis.label}" (${currentDiagnosis.category}) — перезапуск процесса в этом случае не поможет, поэтому автовосстановление не запускалось.\n\n${currentDiagnosis.explanation}\n\n💡 ${currentDiagnosis.suggestion}`
        );
      }
    } else if (attemptsSoFar < recovery.maxAttempts) {
      const triggerAt = recovery.afterFails + attemptsSoFar * recovery.retryAfterFails;

      // ">=", а не "===" — если попытка была отложена cooldown-ом на этом тике,
      // на следующей проверке условие всё ещё истинно, и мы попробуем снова,
      // а не будем ждать следующего порога retryAfterFails.
      if (consecutiveFails >= triggerAt) {
        const lastAttempts = await getRestartLog(monitor.id, 1);
        const lastAttemptTs = lastAttempts.length ? lastAttempts[0].ts : null;
        const cooldownMs = recovery.cooldownMinutes * 60 * 1000;
        const cooldownRemaining = lastAttemptTs ? cooldownMs - (Date.now() - lastAttemptTs) : 0;

        if (cooldownRemaining > 0) {
          // Cooldown ещё не истёк — молча ждём, попробуем на следующей проверке.
          // Не спамим уведомлением на каждый тик.
        } else {
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

  // Failover: проверяем резервный адрес один раз в самом начале падения
  // (сразу при открытии инцидента), чтобы не спамить проверками на каждый тик
  if (statusChanged && newStatus === 'down' && monitor.failover && monitor.failover.backupUrl) {
    checkFailoverBackup(monitor).catch(() => {});
  }

  return result;
}

// --- Failover (облегчённая версия) ---
// Настоящее автоматическое переключение трафика требует контроля над DNS
// (например, через Cloudflare API), которого у нас пока нет. Вместо этого —
// проверяем, жив ли резервный адрес, и явно говорим тебе, что можно вручную
// переключиться, вместо того чтобы притворяться, что переключение уже произошло.
async function checkFailoverBackup(monitor) {
  if (!monitor.failover || !monitor.failover.backupUrl) return;
  try {
    const res = await timingFetch(monitor.failover.backupUrl, { timeoutMs: monitor.timeoutMs || 8000 });
    const backupOk = res.statusCode >= 200 && res.statusCode < 400;
    await notify(
      backupOk ? `🟡 Резервный адрес доступен: ${monitor.name}` : `🔴 Резервный адрес тоже недоступен: ${monitor.name}`,
      backupOk
        ? `Основной адрес "${monitor.name}" недоступен, но резервный (${monitor.failover.backupUrl}) отвечает нормально.\n\nЭто НЕ автоматическое переключение — трафик всё ещё идёт на основной адрес. Если хочешь переключиться, сделай это вручную (смени DNS/ссылку в боте и т.п.).`
        : `Основной адрес "${monitor.name}" недоступен, и резервный (${monitor.failover.backupUrl}) тоже не отвечает. Резервироваться некуда.`
    );
  } catch (e) {
    await notify(
      `🔴 Резервный адрес тоже недоступен: ${monitor.name}`,
      `Основной адрес "${monitor.name}" недоступен. Проверка резервного адреса завершилась ошибкой: ${e.message}`
    );
  }
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
