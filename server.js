require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { runCheck } = require('./checker');
const { diagnose } = require('./diagnosis');
const { checkMultiLocation } = require('./multiLocationCheck');
const { checkTrend } = require('./trendDetection');
const { maybeSendInactivityReport, touchActivity } = require('./inactivityReport');
const {
  initDb,
  getLastCheck, getHistory, getHistoryAggregated, getUptimePercent,
  getResponseStats, getSSLStatus, getDailyUptime, getMonitorSummary,
  getRestartLog, saveMultiLocationResult, getMultiLocationResult, getIncidentsForMonitor,
  getAllMonitorConfigs, upsertMonitorConfig, deleteMonitorConfig, countMonitorConfigs,
  getState,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Список мониторов теперь хранится в Turso (таблица monitor_configs),
// а не только в monitors.json — это позволяет добавлять/редактировать/удалять
// мониторы через UI без правки файла и ожидания редеплоя.
// monitors.json используется только для ОДНОРАЗОВОЙ миграции при самом первом
// запуске, если таблица в БД ещё пустая.
let monitors = [];

async function loadMonitorsFromDb() {
  monitors = await getAllMonitorConfigs();
}

async function migrateFromFileIfNeeded() {
  const count = await countMonitorConfigs();
  if (count > 0) return;

  try {
    const fileMonitors = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitors.json'), 'utf-8'));
    for (const m of fileMonitors) {
      await upsertMonitorConfig(m.id, m);
    }
    console.log(`[migrate] Перенесено ${fileMonitors.length} монитор(ов) из monitors.json в базу данных`);
  } catch (e) {
    console.log('[migrate] monitors.json не найден или пуст — начинаем с чистого списка');
  }
}

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

// Файлы, нужные для отрисовки самой страницы входа — должны быть доступны
// без авторизации, иначе страница логина останется без стилей.
const PUBLIC_PATHS = ['/api/login', '/login.html', '/style.css'];

function requireAuth(req, res, next) {
  if (!AUTH_PASSWORD) return next(); // если пароль не настроен — не блокируем (для локальной разработки)
  if (PUBLIC_PATHS.includes(req.path)) return next();

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token && activeSessions.has(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  return res.redirect('/login.html');
}

app.use(requireAuth);

// Регистрируем "активность в дашборде" для inactivity-дайджеста: любое
// изменяющее действие (логин, ручная проверка, тумблер обслуживания,
// правка конфига) считается признаком того, что человек сейчас смотрит
// в систему. GET-запросы намеренно не считаются — иначе фоновый
// автообновляющийся опрос (каждые 15с, пока открыта вкладка) никогда не
// дал бы засчитать реальное "тишину", даже если человек давно ушёл спать.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    touchActivity(Date.now()).catch((e) => console.error('[activity] Ошибка записи активности:', e.message));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- API ---

app.get('/api/monitors', async (req, res) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;

  let data = await Promise.all(
    monitors.filter((m) => m.type !== 'reminder').map(async (m) => {
      // Раньше эти 4 запроса шли последовательно (await один за другим) —
      // они независимы друг от друга, поэтому распараллеливаем через
      // Promise.all: 4 круговых обращения к БД на монитор превращаются в 1
      // по времени ожидания, а не в 4 подряд.
      const [last, ssl, uptime24h, uptime7d] = await Promise.all([
        getLastCheck(m.id),
        getSSLStatus(m.id),
        getUptimePercent(m.id, now - day),
        getUptimePercent(m.id, now - week),
      ]);
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
        uptime24h,
        uptime7d,
        ssl: ssl ? { valid: !!ssl.valid, daysLeft: ssl.days_left, error: ssl.error } : null,
        hasAutoRestart: !!(m.recovery && m.recovery.provider && m.recovery.provider !== 'none' && m.recovery.enabled !== false) || !!m.deployHookUrl,
        maintenance: (m.maintenance && m.maintenance.enabled && (!m.maintenance.until || Date.now() < m.maintenance.until))
          ? { enabled: true, until: m.maintenance.until }
          : { enabled: false, until: null },
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

// --- Управление мониторами (Этап 9) ---
// Добавление/редактирование/удаление прямо из UI, без правки monitors.json
// на GitHub и ожидания редеплоя — изменения сразу пишутся в Turso.

app.get('/api/config/monitors', (req, res) => {
  res.json(monitors);
});

app.post('/api/monitors/:id/maintenance', async (req, res) => {
  const existing = monitors.find((m) => m.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Монитор не найден' });

  const { enabled, minutes } = req.body || {};
  const until = enabled && minutes ? Date.now() + minutes * 60 * 1000 : null;

  const merged = { ...existing, maintenance: { enabled: !!enabled, until } };
  await upsertMonitorConfig(req.params.id, merged);
  await loadMonitorsFromDb();

  res.json({ ok: true, maintenance: merged.maintenance });
});

function validateMonitorConfig(body) {
  if (!body || typeof body !== 'object') return 'Пустые данные монитора';
  if (!body.id || typeof body.id !== 'string' || !/^[a-z0-9-]+$/.test(body.id)) {
    return 'id обязателен и может содержать только строчные латинские буквы, цифры и дефис';
  }
  if (!body.name || typeof body.name !== 'string') return 'name обязателен';
  if (!['http', 'telegram_bot'].includes(body.type)) return 'type должен быть "http" или "telegram_bot"';
  if (body.type === 'http' && !body.url) return 'url обязателен для type: "http"';
  if (body.type === 'telegram_bot' && !body.botToken) return 'botToken обязателен для type: "telegram_bot"';
  return null;
}

app.post('/api/config/monitors', async (req, res) => {
  const error = validateMonitorConfig(req.body);
  if (error) return res.status(400).json({ error });

  const exists = monitors.find((m) => m.id === req.body.id);
  if (exists) return res.status(409).json({ error: `Монитор с id "${req.body.id}" уже существует` });

  await upsertMonitorConfig(req.body.id, req.body);
  await loadMonitorsFromDb();
  lastRunMap[req.body.id] = 0; // проверим в ближайший тик планировщика

  res.status(201).json({ ok: true });
});

app.put('/api/config/monitors/:id', async (req, res) => {
  const existing = monitors.find((m) => m.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Монитор не найден' });

  const merged = { ...existing, ...req.body, id: req.params.id };
  const error = validateMonitorConfig(merged);
  if (error) return res.status(400).json({ error });

  await upsertMonitorConfig(req.params.id, merged);
  await loadMonitorsFromDb();

  res.json({ ok: true });
});

app.delete('/api/config/monitors/:id', async (req, res) => {
  const existing = monitors.find((m) => m.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Монитор не найден' });

  await deleteMonitorConfig(req.params.id);
  await loadMonitorsFromDb();
  delete lastRunMap[req.params.id];

  res.json({ ok: true });
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

// --- Predictive Failure Detection ---
// Отдельный, более редкий цикл: сравнивать почасовые окна имеет смысл не
// каждую минуту (шумно и дорого по чтению истории), а раз в 15 минут —
// тренд за 4 часа физически не может измениться за минуту.
cron.schedule('*/15 * * * *', () => {
  monitors.filter((m) => m.type === 'http').forEach(async (m) => {
    try {
      const state = await getState(m.id);
      const currentStatus = state ? state.last_status : 'unknown';
      await checkTrend(m, currentStatus);
    } catch (e) {
      console.error(`Ошибка проверки тренда ${m.id}:`, e.message);
    }
  });
});

// --- Inactivity-дайджест ---
// Проверяем сам факт "достаточно долго не было активности" раз в 15 минут —
// отчёт же не по расписанию, а от порога тишины, так что часто дёргать
// эту проверку смысла нет (максимум опоздает на 15 мин относительно
// точного момента, когда порог пройден — это некритично).
cron.schedule('*/15 * * * *', () => {
  maybeSendInactivityReport(monitors).catch((e) => console.error('[inactivityReport] Ошибка:', e.message));
});

// --- Запуск: сначала инициализируем БД, потом стартуем сервер и проверки ---
async function start() {
  await initDb();
  await migrateFromFileIfNeeded();
  await loadMonitorsFromDb();

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
