const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error(
    'Не заданы TURSO_DATABASE_URL и/или TURSO_AUTH_TOKEN в переменных окружения. ' +
    'Без них база данных работать не может — см. README о настройке Turso.'
  );
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function q(sql, args) {
  const res = await client.execute({ sql, args: args || [] });
  return res.rows;
}

async function qOne(sql, args) {
  const rows = await q(sql, args);
  return rows[0] || null;
}

async function run(sql, args) {
  return client.execute({ sql, args: args || [] });
}

async function initDb() {
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        response_ms INTEGER,
        status_code INTEGER,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts)`,
      `CREATE TABLE IF NOT EXISTS monitor_state (
        monitor_id TEXT PRIMARY KEY,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        last_change_ts INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS ssl_status (
        monitor_id TEXT PRIMARY KEY,
        valid INTEGER,
        expires_at INTEGER,
        days_left INTEGER,
        checked_at INTEGER,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS restart_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        success INTEGER,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS multi_location_results (
        monitor_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        results_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'ongoing',
        cause_category TEXT,
        cause_label TEXT,
        cause_explanation TEXT,
        cause_suggestion TEXT,
        last_error TEXT,
        checks_failed INTEGER DEFAULT 1,
        recovery_attempted INTEGER DEFAULT 0,
        recovery_provider TEXT,
        recovery_result TEXT,
        notification_sent INTEGER DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS monitor_configs (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER
      )`,
    ],
    'write'
  );

  const migrations = [
    `ALTER TABLE checks ADD COLUMN response_headers TEXT`,
    `ALTER TABLE checks ADD COLUMN content_ok INTEGER`,
    `ALTER TABLE checks ADD COLUMN timing_breakdown TEXT`,
    `ALTER TABLE checks ADD COLUMN bot_health TEXT`,
    `ALTER TABLE checks ADD COLUMN response_size INTEGER`,
    `ALTER TABLE checks ADD COLUMN size_anomaly INTEGER DEFAULT 0`,
    `ALTER TABLE monitor_state ADD COLUMN consecutive_fails INTEGER DEFAULT 0`,
    `ALTER TABLE monitor_state ADD COLUMN restart_attempted INTEGER DEFAULT 0`,
    `ALTER TABLE monitor_state ADD COLUMN recovery_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE monitor_state ADD COLUMN recovery_exhausted_notified INTEGER DEFAULT 0`,
    `ALTER TABLE monitor_state ADD COLUMN last_flapping_notified_ts INTEGER`,
    `ALTER TABLE monitor_state ADD COLUMN current_incident_id INTEGER`,
    `ALTER TABLE restart_log ADD COLUMN incident_id INTEGER`,
  ];
  for (const sql of migrations) {
    try {
      await client.execute(sql);
    } catch (e) {
      // колонка уже существует — это нормально, игнорируем
    }
  }

  console.log('[db] Turso: схема инициализирована');
}

async function insertCheck(monitorId, ok, responseMs, statusCode, error, responseHeaders, contentOk, timing, botHealth, responseSize, sizeAnomaly) {
  await run(
    `INSERT INTO checks (monitor_id, ts, ok, response_ms, status_code, error, response_headers, content_ok, timing_breakdown, bot_health, response_size, size_anomaly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      monitorId, Date.now(), ok ? 1 : 0, responseMs ?? null, statusCode ?? null, error ?? null,
      responseHeaders ? JSON.stringify(responseHeaders) : null,
      contentOk === undefined || contentOk === null ? null : (contentOk ? 1 : 0),
      timing ? JSON.stringify(timing) : null,
      botHealth ? JSON.stringify(botHealth) : null,
      responseSize ?? null,
      sizeAnomaly ? 1 : 0,
    ]
  );
}

async function getRecentResponseSizes(monitorId, limit) {
  const rows = await q(
    `SELECT response_size FROM checks WHERE monitor_id = ? AND ok = 1 AND response_size IS NOT NULL ORDER BY ts DESC LIMIT ?`,
    [monitorId, limit || 30]
  );
  return rows.map((r) => r.response_size);
}

async function getLastCheck(monitorId) {
  return qOne(`SELECT * FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 1`, [monitorId]);
}

async function getHistory(monitorId, sinceTs) {
  return q(`SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC`, [monitorId, sinceTs]);
}

async function getHistoryAggregated(monitorId, sinceTs, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const rows = await q(`SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC`, [monitorId, sinceTs]);

  const buckets = new Map();
  for (const row of rows) {
    const bucketKey = Math.floor(row.ts / bucketMs) * bucketMs;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { ts: bucketKey, sumMs: 0, count: 0, total: 0, okCount: 0, lastError: null });
    }
    const b = buckets.get(bucketKey);
    if (row.response_ms !== null) {
      b.sumMs += row.response_ms;
      b.count += 1;
    }
    b.total += 1;
    if (row.ok) b.okCount += 1;
    if (!row.ok) b.lastError = row.error;
  }

  return [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: b.ts,
      response_ms: b.count ? Math.round(b.sumMs / b.count) : null,
      ok: b.okCount === b.total ? 1 : 0,
      error: b.lastError,
    }));
}

async function getUptimePercent(monitorId, sinceTs) {
  const row = await qOne(
    `SELECT COUNT(*) as total, SUM(ok) as up FROM checks WHERE monitor_id = ? AND ts >= ?`,
    [monitorId, sinceTs]
  );
  if (!row || !row.total) return null;
  return Math.round((Number(row.up) / Number(row.total)) * 10000) / 100;
}

async function getResponseStats(monitorId, sinceTs) {
  const row = await qOne(
    `SELECT AVG(response_ms) as avg, MIN(response_ms) as min, MAX(response_ms) as max
     FROM checks WHERE monitor_id = ? AND ts >= ? AND ok = 1`,
    [monitorId, sinceTs]
  );
  return {
    avg: row && row.avg !== null ? Math.round(row.avg) : null,
    min: row ? row.min ?? null : null,
    max: row ? row.max ?? null : null,
  };
}

async function getDailyUptime(monitorId, days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await q(
    `SELECT date(ts / 1000, 'unixepoch') as day, COUNT(*) as total, SUM(ok) as up
     FROM checks WHERE monitor_id = ? AND ts >= ? GROUP BY day ORDER BY day ASC`,
    [monitorId, since]
  );
  return rows.map((r) => ({
    day: r.day,
    uptime: r.total ? Math.round((Number(r.up) / Number(r.total)) * 10000) / 100 : null,
  }));
}

async function getMonitorSummary(monitorId, sinceTs) {
  const uptimeRow = await qOne(
    `SELECT COUNT(*) as total, SUM(ok) as up FROM checks WHERE monitor_id = ? AND ts >= ?`,
    [monitorId, sinceTs]
  );
  const respRow = await qOne(
    `SELECT AVG(response_ms) as avg FROM checks WHERE monitor_id = ? AND ts >= ? AND ok = 1`,
    [monitorId, sinceTs]
  );
  const incidentsCountRow = await qOne(
    `SELECT COUNT(*) as cnt FROM incidents WHERE monitor_id = ? AND started_at >= ?`,
    [monitorId, sinceTs]
  );

  return {
    uptime: uptimeRow && uptimeRow.total ? Math.round((Number(uptimeRow.up) / Number(uptimeRow.total)) * 10000) / 100 : null,
    avgResponseMs: respRow && respRow.avg !== null ? Math.round(respRow.avg) : null,
    incidentsCount: incidentsCountRow ? Number(incidentsCountRow.cnt) : 0,
  };
}

async function getState(monitorId) {
  return qOne(`SELECT * FROM monitor_state WHERE monitor_id = ?`, [monitorId]);
}

async function updateMonitorState(monitorId, ok) {
  const prev = await getState(monitorId);
  const prevStatus = prev ? prev.last_status : 'unknown';
  const newStatus = ok ? 'up' : 'down';
  const consecutiveFails = ok ? 0 : (prev ? (prev.consecutive_fails || 0) : 0) + 1;
  const restartAttempted = ok ? 0 : (prev ? (prev.restart_attempted || 0) : 0);
  const recoveryAttempts = ok ? 0 : (prev ? (prev.recovery_attempts || 0) : 0);
  const recoveryExhaustedNotified = ok ? 0 : (prev ? (prev.recovery_exhausted_notified || 0) : 0);
  const statusChanged = prevStatus !== newStatus;
  const lastChangeTs = statusChanged ? Date.now() : (prev ? prev.last_change_ts : Date.now());

  await run(
    `INSERT INTO monitor_state (monitor_id, last_status, last_change_ts, consecutive_fails, restart_attempted, recovery_attempts, recovery_exhausted_notified)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       last_status = excluded.last_status,
       last_change_ts = ?,
       consecutive_fails = excluded.consecutive_fails,
       restart_attempted = excluded.restart_attempted,
       recovery_attempts = excluded.recovery_attempts,
       recovery_exhausted_notified = excluded.recovery_exhausted_notified`,
    [monitorId, newStatus, Date.now(), consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified, lastChangeTs]
  );

  return { prevStatus, newStatus, statusChanged, consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified };
}

async function markRestartAttempted(monitorId) {
  await run(`UPDATE monitor_state SET restart_attempted = 1 WHERE monitor_id = ?`, [monitorId]);
}

async function incrementRecoveryAttempts(monitorId) {
  await run(`UPDATE monitor_state SET recovery_attempts = recovery_attempts + 1 WHERE monitor_id = ?`, [monitorId]);
}

async function markRecoveryExhaustedNotified(monitorId) {
  await run(`UPDATE monitor_state SET recovery_exhausted_notified = 1 WHERE monitor_id = ?`, [monitorId]);
}

async function setSSLStatus(monitorId, valid, expiresAt, daysLeft, error) {
  await run(
    `INSERT INTO ssl_status (monitor_id, valid, expires_at, days_left, checked_at, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       valid = excluded.valid, expires_at = excluded.expires_at, days_left = excluded.days_left,
       checked_at = excluded.checked_at, error = excluded.error`,
    [monitorId, valid ? 1 : 0, expiresAt ?? null, daysLeft ?? null, Date.now(), error ?? null]
  );
}

async function getSSLStatus(monitorId) {
  return qOne(`SELECT * FROM ssl_status WHERE monitor_id = ?`, [monitorId]);
}

async function logRestartAttempt(monitorId, success, error, incidentId) {
  await run(
    `INSERT INTO restart_log (monitor_id, ts, success, error, incident_id) VALUES (?, ?, ?, ?, ?)`,
    [monitorId, Date.now(), success ? 1 : 0, error ?? null, incidentId ?? null]
  );
}

async function getRestartLog(monitorId, limit) {
  return q(`SELECT * FROM restart_log WHERE monitor_id = ? ORDER BY ts DESC LIMIT ?`, [monitorId, limit || 10]);
}

async function countRecentRestarts(monitorId, sinceTs) {
  const row = await qOne(`SELECT COUNT(*) as cnt FROM restart_log WHERE monitor_id = ? AND ts >= ?`, [monitorId, sinceTs]);
  return row ? Number(row.cnt) : 0;
}

async function saveMultiLocationResult(monitorId, results) {
  await run(
    `INSERT INTO multi_location_results (monitor_id, ts, results_json)
     VALUES (?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET ts = excluded.ts, results_json = excluded.results_json`,
    [monitorId, Date.now(), JSON.stringify(results)]
  );
}

async function getMultiLocationResult(monitorId) {
  const row = await qOne(`SELECT * FROM multi_location_results WHERE monitor_id = ?`, [monitorId]);
  if (!row) return null;
  return { ts: row.ts, results: JSON.parse(row.results_json) };
}

async function openIncident(monitorId, startedAt, causeCategory, causeLabel, causeExplanation, causeSuggestion, error) {
  const info = await run(
    `INSERT INTO incidents (monitor_id, started_at, status, cause_category, cause_label, cause_explanation, cause_suggestion, last_error, checks_failed)
     VALUES (?, ?, 'ongoing', ?, ?, ?, ?, ?, 1)`,
    [monitorId, startedAt, causeCategory ?? null, causeLabel ?? null, causeExplanation ?? null, causeSuggestion ?? null, error ?? null]
  );
  const incidentId = Number(info.lastInsertRowid);
  await run(`UPDATE monitor_state SET current_incident_id = ? WHERE monitor_id = ?`, [incidentId, monitorId]);
  return incidentId;
}

async function incrementIncidentChecks(incidentId, error) {
  if (!incidentId) return;
  await run(`UPDATE incidents SET checks_failed = checks_failed + 1, last_error = ? WHERE id = ?`, [error ?? null, incidentId]);
}

async function closeIncident(monitorId, incidentId, endedAt) {
  if (!incidentId) return;
  await run(`UPDATE incidents SET status = 'recovered', ended_at = ? WHERE id = ?`, [endedAt, incidentId]);
  await run(`UPDATE monitor_state SET current_incident_id = NULL WHERE monitor_id = ?`, [monitorId]);
}

async function markIncidentNotified(incidentId) {
  if (!incidentId) return;
  await run(`UPDATE incidents SET notification_sent = 1 WHERE id = ?`, [incidentId]);
}

async function markIncidentRecovery(incidentId, provider, result) {
  if (!incidentId) return;
  await run(`UPDATE incidents SET recovery_attempted = 1, recovery_provider = ?, recovery_result = ? WHERE id = ?`, [provider, result, incidentId]);
}

async function getIncidentsForMonitor(monitorId, sinceTs, limit) {
  return q(`SELECT * FROM incidents WHERE monitor_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT ?`, [monitorId, sinceTs, limit || 50]);
}

// --- Flapping detection ---
// Использует уже существующую таблицу incidents — просто считает, сколько
// отдельных падений было у монитора за последнее время. Ничего нового
// собирать не нужно.

async function countRecentIncidents(monitorId, sinceTs) {
  const row = await qOne(`SELECT COUNT(*) as cnt FROM incidents WHERE monitor_id = ? AND started_at >= ?`, [monitorId, sinceTs]);
  return row ? Number(row.cnt) : 0;
}

async function markFlappingNotified(monitorId) {
  await run(`UPDATE monitor_state SET last_flapping_notified_ts = ? WHERE monitor_id = ?`, [Date.now(), monitorId]);
}

// --- Конфигурация мониторов (для UI управления, Этап 9) ---

async function getAllMonitorConfigs() {
  const rows = await q(`SELECT * FROM monitor_configs ORDER BY created_at ASC`);
  return rows.map((r) => JSON.parse(r.config_json));
}

async function upsertMonitorConfig(id, configObj) {
  const now = Date.now();
  const existing = await qOne(`SELECT created_at FROM monitor_configs WHERE id = ?`, [id]);
  await run(
    `INSERT INTO monitor_configs (id, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
    [id, JSON.stringify(configObj), existing ? existing.created_at : now, now]
  );
}

async function deleteMonitorConfig(id) {
  await run(`DELETE FROM monitor_configs WHERE id = ?`, [id]);
}

async function countMonitorConfigs() {
  const row = await qOne(`SELECT COUNT(*) as cnt FROM monitor_configs`);
  return row ? Number(row.cnt) : 0;
}

module.exports = {
  initDb,
  insertCheck,
  getRecentResponseSizes,
  getLastCheck,
  getHistory,
  getHistoryAggregated,
  getUptimePercent,
  getResponseStats,
  getDailyUptime,
  getMonitorSummary,
  getState,
  updateMonitorState,
  markRestartAttempted,
  incrementRecoveryAttempts,
  markRecoveryExhaustedNotified,
  setSSLStatus,
  getSSLStatus,
  logRestartAttempt,
  getRestartLog,
  countRecentRestarts,
  saveMultiLocationResult,
  getMultiLocationResult,
  openIncident,
  incrementIncidentChecks,
  closeIncident,
  markIncidentNotified,
  markIncidentRecovery,
  getIncidentsForMonitor,
  countRecentIncidents,
  markFlappingNotified,
  getAllMonitorConfigs,
  upsertMonitorConfig,
  deleteMonitorConfig,
  countMonitorConfigs,
};
