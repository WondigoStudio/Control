require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { runCheck } = require('./checker');
const { diagnose } = require('./diagnosis');
const { checkMultiLocation } = require('./multiLocationCheck');
const {
  initDb,
  getLastCheck, getHistory, getHistoryAggregated, getUptimePercent,
  getResponseStats, getSSLStatus, getDailyUptime, getMonitorSummary,
  getRestartLog, saveMultiLocationResult, getMultiLocationResult, getIncidentsForMonitor,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const monitors = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitors.json'), 'utf-8'));

// --- Авторизация ---
// Простая защита паролем: страница логина + сессия по httpOnly-куке.
// Пароль сравнивается через timingSafeEqual, чтобы не утекала информация
// о совпадении по времени ответа.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || null;
const SESSION_COOKIE = 'monitor_session';
const activeSessions = new Set(); // в памяти — сбрасывается при рестарте, это ок для личного дашборда

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // всё равно делаем сравнение фиксированной длины, чтобы не палить длину пароля по времени
    crypto.timingSafeEqual(Buffer.alloc(64), Buffer.alloc(64));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
}

app.use(express.json());

app.post('/api/login', (req, res) => {
  if (!AUTH_PASSWORD) {
    return res.status(500).json({ error: 'AUTH_PASSWORD не настроен на сервере' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeCompare(password, AUTH_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = crypto.randomBytes(48).toString('hex');
  activeSessions.add(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) activeSessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (!AUTH_PASSWORD) return next(); // если пароль не настроен — не блокируем (для локальной разработки)
  if (req.path === '/api/login' || req.path === '/login.html') return next();

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token && activeSessions.has(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  return res.redirect('/login.html');
}

app.use(requireAuth);

app.use(express.static(path.join(__dirname, 'public')));

// --- API ---

app.get('/api/monitors', async (req, res) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;

  let data = await Promise.all(
    monitors.filter((m) => m.type !== 'reminder').map(async (m) => {
      const last = await getLastCheck(m.id);
      const ssl = await getSSLStatus(m.id);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        target: m.url || m.name,
        status: last ? (last.ok ? 'up' : 'down') : 'unknown',
        lastResponseMs: last ? last.response_ms : null,
        lastCheckedAt: last ? last.ts : null,
        lastError: last ? last.error : null,
        lastErrorDiagnosis: last && !last.ok ? diagnose({ error: last.error, statusCode: last.status_code, responseMs: last.response_ms, timeoutMs: m.timeoutMs, hosting: m.hosting }) : null,
        hosting: m.hosting || 'other',
        uptime24h: await getUptimePercent(m.id, now - day),
        uptime7d: await getUptimePercent(m.id, now - week),
        ssl: ssl ? { valid: !!ssl.valid, daysLeft: ssl.days_left, error: ssl.error } : null,
        hasAutoRestart: !!(m.recovery && m.recovery.provider && m.recovery.provider !== 'none' && m.recovery.enabled !== false) || !!m.deployHookUrl,
        recoveryProvider: m.recovery ? m.recovery.provider : (m.deployHookUrl ? 'render' : 'none'),
      };
    })
  );

  if (req.query.sort === 'reliability') {
    data = data.sort((a, b) => (b.uptime7d ?? -1) - (a.uptime7d ?? -1));
  }

  res.json(data);
});

app.get('/api/monitors/:id/restarts', async (req, res) => {
  const log = await getRestartLog(req.params.id, 10);
  res.json(log);
});

app.get('/api/monitors/:id/locations', async (req, res) => {
  const cached = await getMultiLocationResult(req.params.id);
  res.json(cached);
});

app.post('/api/monitors/:id/locations', async (req, res) => {
  const monitor = monitors.find((m) => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Монитор не найден' });
  if (monitor.type !== 'http' || !monitor.url) {
    return res.status(400).json({ error: 'Проверка из разных локаций доступна только для http-мониторов' });
  }
  try {
    const results = await checkMultiLocation(monitor.url);
    await saveMultiLocationResult(monitor.id, results);
    res.json({ ts: Date.now(), results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/monitors/:id/history', async (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const since = Date.now() - hours * 60 * 60 * 1000;

  let history;
  if (hours <= 24) {
    history = await getHistory(req.params.id, since);
  } else if (hours <= 168) {
    history = await getHistoryAggregated(req.params.id, since, 60);
  } else {
    history = await getHistoryAggregated(req.params.id, since, 240);
  }

  res.json(history);
});

app.get('/api/monitors/:id/incidents', async (req, res) => {
  const days = parseInt(req.query.days || '7', 10);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = await getIncidentsForMonitor(req.params.id, since, 100);

  const incidents = rows.map((inc) => ({
    id: inc.id,
    start: inc.started_at,
    end: inc.ended_at,
    ongoing: !inc.ended_at,
    durationMs: (inc.ended_at || Date.now()) - inc.started_at,
    error: inc.last_error,
    checksFailed: inc.checks_failed,
    diagnosis: {
      category: inc.cause_category || 'UNKNOWN',
      label: inc.cause_label || 'Неизвестная ошибка',
      explanation: inc.cause_explanation || inc.last_error || 'Причина не определена',
      suggestion: inc.cause_suggestion || 'Проверь логи хостинга вручную за это время.',
    },
    recovery: {
      attempted: !!inc.recovery_attempted,
      provider: inc.recovery_provider,
      result: inc.recovery_result,
    },
    notificationSent: !!inc.notification_sent,
  }));

  res.json(incidents);
});

app.get('/api/monitors/:id/stats', async (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const stats = await getResponseStats(req.params.id, since);
  res.json(stats);
});

app.get('/api/monitors/:id/heatmap', async (req, res) => {
  const days = parseInt(req.query.days || '90', 10);
  const heatmap = await getDailyUptime(req.params.id, days);
  res.json(heatmap);
});

app.get('/api/time', (req, res) => {
  res.json({ now: Date.now() });
});

app.get('/api/summary', async (req, res) => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - week;

  const data = await Promise.all(
    monitors.filter((m) => m.type !== 'reminder').map(async (m) => {
      const s = await getMonitorSummary(m.id, since);
      return { id: m.id, name: m.name, uptime7d: s.uptime, avgResponseMs: s.avgResponseMs, incidentsCount: s.incidentsCount };
    })
  );

  data.sort((a, b) => (a.uptime7d ?? 101) - (b.uptime7d ?? 101));

  res.json(data);
});

app.post('/api/monitors/:id/check-now', async (req, res) => {
  const monitor = monitors.find((m) => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Монитор не найден' });
  const result = await runCheck(monitor);
  res.json(result);
});

// --- Планировщик ---
const lastRunMap = {};

cron.schedule('* * * * *', () => {
  const now = Date.now();
  monitors.filter((m) => m.type !== 'reminder').forEach(async (m) => {
    const interval = (m.intervalSec || 60) * 1000;
    const last = lastRunMap[m.id] || 0;
    if (now - last >= interval) {
      lastRunMap[m.id] = now;
      try {
        await runCheck(m);
      } catch (e) {
        console.error(`Ошибка проверки ${m.id}:`, e.message);
      }
    }
  });
});

// --- Запуск: сначала инициализируем БД, потом стартуем сервер и проверки ---
async function start() {
  await initDb();

  for (const m of monitors.filter((x) => x.type !== 'reminder')) {
    lastRunMap[m.id] = Date.now();
    try {
      await runCheck(m);
    } catch (e) {
      console.error(`Ошибка первой проверки ${m.id}:`, e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`Status Monitor запущен: http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error('Не удалось запустить сервер:', e);
  process.exit(1);
});
