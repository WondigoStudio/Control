require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const { runCheck } = require('./checker');
const { getLastCheck, getHistory, getHistoryAggregated, getUptimePercent, getIncidents, getResponseStats, getSSLStatus, getDailyUptime, getMonitorSummary, getRestartLog } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const monitors = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitors.json'), 'utf-8'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/monitors', (req, res) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;

  let data = monitors.map((m) => {
    const last = getLastCheck(m.id);
    const ssl = getSSLStatus(m.id);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      target: m.url || m.name,
      status: last ? (last.ok ? 'up' : 'down') : 'unknown',
      lastResponseMs: last ? last.response_ms : null,
      lastCheckedAt: last ? last.ts : null,
      lastError: last ? last.error : null,
      uptime24h: getUptimePercent(m.id, now - day),
      uptime7d: getUptimePercent(m.id, now - week),
      ssl: ssl ? { valid: !!ssl.valid, daysLeft: ssl.days_left, error: ssl.error } : null,
      hasAutoRestart: !!m.deployHookUrl,
    };
  });

  if (req.query.sort === 'reliability') {
    data = data.sort((a, b) => (b.uptime7d ?? -1) - (a.uptime7d ?? -1));
  }

  res.json(data);
});

app.get('/api/monitors/:id/restarts', (req, res) => {
  const log = getRestartLog(req.params.id, 10);
  res.json(log);
});

app.get('/api/monitors/:id/history', (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const since = Date.now() - hours * 60 * 60 * 1000;

  let history;
  if (hours <= 24) {
    history = getHistory(req.params.id, since);
  } else if (hours <= 168) {
    history = getHistoryAggregated(req.params.id, since, 60);
  } else {
    history = getHistoryAggregated(req.params.id, since, 240);
  }

  res.json(history);
});

app.get('/api/monitors/:id/incidents', (req, res) => {
  const days = parseInt(req.query.days || '7', 10);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const incidents = getIncidents(req.params.id, since);
  res.json(incidents);
});

app.get('/api/monitors/:id/stats', (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const stats = getResponseStats(req.params.id, since);
  res.json(stats);
});

app.get('/api/monitors/:id/heatmap', (req, res) => {
  const days = parseInt(req.query.days || '90', 10);
  const heatmap = getDailyUptime(req.params.id, days);
  res.json(heatmap);
});

app.get('/api/time', (req, res) => {
  res.json({ now: Date.now() });
});

app.get('/api/summary', (req, res) => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - week;

  const data = monitors.map((m) => {
    const s = getMonitorSummary(m.id, since);
    return { id: m.id, name: m.name, uptime7d: s.uptime, avgResponseMs: s.avgResponseMs, incidentsCount: s.incidentsCount };
  });

  data.sort((a, b) => (a.uptime7d ?? 101) - (b.uptime7d ?? 101));

  res.json(data);
});

app.post('/api/monitors/:id/check-now', async (req, res) => {
  const monitor = monitors.find((m) => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Монитор не найден' });
  const result = await runCheck(monitor);
  res.json(result);
});

const lastRunMap = {};

cron.schedule('* * * * *', () => {
  const now = Date.now();
  monitors.forEach(async (m) => {
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

monitors.forEach(async (m) => {
  lastRunMap[m.id] = Date.now();
  try {
    await runCheck(m);
  } catch (e) {
    console.error(`Ошибка первой проверки ${m.id}:`, e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Status Monitor запущен: http://localhost:${PORT}`);
});
