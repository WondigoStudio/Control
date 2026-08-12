const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'monitor.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  response_ms INTEGER,
  status_code INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts);

CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id TEXT PRIMARY KEY,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_change_ts INTEGER
);

CREATE TABLE IF NOT EXISTS ssl_status (
  monitor_id TEXT PRIMARY KEY,
  valid INTEGER,
  expires_at INTEGER,
  days_left INTEGER,
  checked_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS restart_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  success INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS multi_location_results (
  monitor_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  results_json TEXT NOT NULL
);
`);

// Миграция: добавляем новые колонки в уже существующие БД без пересоздания таблицы
try { db.exec("ALTER TABLE checks ADD COLUMN response_headers TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE checks ADD COLUMN content_ok INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE checks ADD COLUMN timing_breakdown TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE monitor_state ADD COLUMN consecutive_fails INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE monitor_state ADD COLUMN restart_attempted INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE checks ADD COLUMN bot_health TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE monitor_state ADD COLUMN recovery_attempts INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE monitor_state ADD COLUMN recovery_exhausted_notified INTEGER DEFAULT 0"); } catch (e) {}

function insertCheck(monitorId, ok, responseMs, statusCode, error, responseHeaders, contentOk, timing, botHealth) {
  const stmt = db.prepare(`
    INSERT INTO checks (monitor_id, ts, ok, response_ms, status_code, error, response_headers, content_ok, timing_breakdown, bot_health)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    monitorId, Date.now(), ok ? 1 : 0, responseMs ?? null, statusCode ?? null, error ?? null,
    responseHeaders ? JSON.stringify(responseHeaders) : null,
    contentOk === undefined || contentOk === null ? null : (contentOk ? 1 : 0),
    timing ? JSON.stringify(timing) : null,
    botHealth ? JSON.stringify(botHealth) : null
  );
}

function setSSLStatus(monitorId, valid, expiresAt, daysLeft, error) {
  db.prepare(`
    INSERT INTO ssl_status (monitor_id, valid, expires_at, days_left, checked_at, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id) DO UPDATE SET
      valid = excluded.valid,
      expires_at = excluded.expires_at,
      days_left = excluded.days_left,
      checked_at = excluded.checked_at,
      error = excluded.error
  `).run(monitorId, valid ? 1 : 0, expiresAt ?? null, daysLeft ?? null, Date.now(), error ?? null);
}

function getSSLStatus(monitorId) {
  return db.prepare(`SELECT * FROM ssl_status WHERE monitor_id = ?`).get(monitorId);
}

function getDailyUptime(monitorId, days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT
      date(ts / 1000, 'unixepoch') as day,
      COUNT(*) as total,
      SUM(ok) as up
    FROM checks
    WHERE monitor_id = ? AND ts >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(monitorId, since);

  return rows.map((r) => ({
    day: r.day,
    uptime: r.total ? Math.round((r.up / r.total) * 10000) / 100 : null,
  }));
}

function getMonitorSummary(monitorId, sinceTs) {
  const uptimeRow = db.prepare(`
    SELECT COUNT(*) as total, SUM(ok) as up FROM checks WHERE monitor_id = ? AND ts >= ?
  `).get(monitorId, sinceTs);
  const respRow = db.prepare(`
    SELECT AVG(response_ms) as avg FROM checks WHERE monitor_id = ? AND ts >= ? AND ok = 1
  `).get(monitorId, sinceTs);
  const incidentsCount = getIncidents(monitorId, sinceTs).length;

  return {
    uptime: uptimeRow && uptimeRow.total ? Math.round((uptimeRow.up / uptimeRow.total) * 10000) / 100 : null,
    avgResponseMs: respRow && respRow.avg !== null ? Math.round(respRow.avg) : null,
    incidentsCount,
  };
}

function getLastCheck(monitorId) {
  return db.prepare(`
    SELECT * FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 1
  `).get(monitorId);
}

function getHistory(monitorId, sinceTs) {
  return db.prepare(`
    SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC
  `).all(monitorId, sinceTs);
}

function getHistoryAggregated(monitorId, sinceTs, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const rows = db.prepare(`
    SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC
  `).all(monitorId, sinceTs);

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

function getUptimePercent(monitorId, sinceTs) {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(ok) as up
    FROM checks WHERE monitor_id = ? AND ts >= ?
  `).get(monitorId, sinceTs);
  if (!row || !row.total) return null;
  return Math.round((row.up / row.total) * 10000) / 100;
}

function getState(monitorId) {
  return db.prepare(`SELECT * FROM monitor_state WHERE monitor_id = ?`).get(monitorId);
}

function getIncidents(monitorId, sinceTs) {
  const rows = db.prepare(`
    SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC
  `).all(monitorId, sinceTs);

  const incidents = [];
  let current = null;

  for (const row of rows) {
    if (!row.ok) {
      if (!current) {
        current = { start: row.ts, end: row.ts, error: row.error, ongoing: true };
      } else {
        current.end = row.ts;
        current.error = row.error || current.error;
      }
    } else if (current) {
      current.ongoing = false;
      incidents.push(current);
      current = null;
    }
  }
  if (current) incidents.push(current);

  return incidents.reverse().map((inc) => ({
    ...inc,
    durationMs: inc.end - inc.start,
  }));
}

function getResponseStats(monitorId, sinceTs) {
  const row = db.prepare(`
    SELECT AVG(response_ms) as avg, MIN(response_ms) as min, MAX(response_ms) as max
    FROM checks WHERE monitor_id = ? AND ts >= ? AND ok = 1
  `).get(monitorId, sinceTs);
  return {
    avg: row.avg !== null ? Math.round(row.avg) : null,
    min: row.min ?? null,
    max: row.max ?? null,
  };
}

function updateMonitorState(monitorId, ok) {
  const prev = getState(monitorId);
  const prevStatus = prev ? prev.last_status : 'unknown';
  const newStatus = ok ? 'up' : 'down';
  const consecutiveFails = ok ? 0 : (prev ? (prev.consecutive_fails || 0) : 0) + 1;
  const restartAttempted = ok ? 0 : (prev ? (prev.restart_attempted || 0) : 0);
  const recoveryAttempts = ok ? 0 : (prev ? (prev.recovery_attempts || 0) : 0);
  const recoveryExhaustedNotified = ok ? 0 : (prev ? (prev.recovery_exhausted_notified || 0) : 0);
  const statusChanged = prevStatus !== newStatus;

  db.prepare(`
    INSERT INTO monitor_state (monitor_id, last_status, last_change_ts, consecutive_fails, restart_attempted, recovery_attempts, recovery_exhausted_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id) DO UPDATE SET
      last_status = excluded.last_status,
      last_change_ts = ?,
      consecutive_fails = excluded.consecutive_fails,
      restart_attempted = excluded.restart_attempted,
      recovery_attempts = excluded.recovery_attempts,
      recovery_exhausted_notified = excluded.recovery_exhausted_notified
  `).run(
    monitorId, newStatus, Date.now(), consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified,
    statusChanged ? Date.now() : (prev ? prev.last_change_ts : Date.now())
  );

  return { prevStatus, newStatus, statusChanged, consecutiveFails, restartAttempted, recoveryAttempts, recoveryExhaustedNotified };
}

function incrementRecoveryAttempts(monitorId) {
  db.prepare(`UPDATE monitor_state SET recovery_attempts = recovery_attempts + 1 WHERE monitor_id = ?`).run(monitorId);
}

function markRecoveryExhaustedNotified(monitorId) {
  db.prepare(`UPDATE monitor_state SET recovery_exhausted_notified = 1 WHERE monitor_id = ?`).run(monitorId);
}

function countRecentRestarts(monitorId, sinceTs) {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM restart_log WHERE monitor_id = ? AND ts >= ?
  `).get(monitorId, sinceTs);
  return row ? row.cnt : 0;
}

function markRestartAttempted(monitorId) {
  db.prepare(`UPDATE monitor_state SET restart_attempted = 1 WHERE monitor_id = ?`).run(monitorId);
}

function logRestartAttempt(monitorId, success, error) {
  db.prepare(`
    INSERT INTO restart_log (monitor_id, ts, success, error) VALUES (?, ?, ?, ?)
  `).run(monitorId, Date.now(), success ? 1 : 0, error ?? null);
}

function getRestartLog(monitorId, limit) {
  return db.prepare(`
    SELECT * FROM restart_log WHERE monitor_id = ? ORDER BY ts DESC LIMIT ?
  `).all(monitorId, limit || 10);
}

function saveMultiLocationResult(monitorId, results) {
  db.prepare(`
    INSERT INTO multi_location_results (monitor_id, ts, results_json)
    VALUES (?, ?, ?)
    ON CONFLICT(monitor_id) DO UPDATE SET ts = excluded.ts, results_json = excluded.results_json
  `).run(monitorId, Date.now(), JSON.stringify(results));
}

function getMultiLocationResult(monitorId) {
  const row = db.prepare(`SELECT * FROM multi_location_results WHERE monitor_id = ?`).get(monitorId);
  if (!row) return null;
  return { ts: row.ts, results: JSON.parse(row.results_json) };
}

module.exports = {
  db,
  insertCheck,
  getLastCheck,
  getHistory,
  getUptimePercent,
  getState,
  updateMonitorState,
  markRestartAttempted,
  logRestartAttempt,
  getRestartLog,
  getIncidents,
  getResponseStats,
  setSSLStatus,
  getSSLStatus,
  getDailyUptime,
  getHistoryAggregated,
  getMonitorSummary,
  saveMultiLocationResult,
  getMultiLocationResult,
  incrementRecoveryAttempts,
  markRecoveryExhaustedNotified,
  countRecentRestarts,
};
