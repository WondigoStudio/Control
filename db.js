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
`);

function insertCheck(monitorId, ok, responseMs, statusCode, error) {
  const stmt = db.prepare(`
    INSERT INTO checks (monitor_id, ts, ok, response_ms, status_code, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(monitorId, Date.now(), ok ? 1 : 0, responseMs ?? null, statusCode ?? null, error ?? null);
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

function setState(monitorId, status) {
  db.prepare(`
    INSERT INTO monitor_state (monitor_id, last_status, last_change_ts)
    VALUES (?, ?, ?)
    ON CONFLICT(monitor_id) DO UPDATE SET last_status = excluded.last_status, last_change_ts = excluded.last_change_ts
  `).run(monitorId, status, Date.now());
}

module.exports = {
  db,
  insertCheck,
  getLastCheck,
  getHistory,
  getUptimePercent,
  getState,
  setState,
  getIncidents,
  getResponseStats,
};
