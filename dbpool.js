// Пул Postgres с запасными базами.
//
// Зачем: бесплатная БД (Neon и т.п.) может "умереть" - упереться в лимит места или часов,
// быть приостановлена, недоступна по сети. Тогда Control продолжает работать на следующей базе из списка.
//
// Как задаются базы (по приоритету):
//   DATABASE_URL, DATABASE_URL_2, DATABASE_URL_3 ... DATABASE_URL_9
//   DATABASE_URLS - дополнительно, список через запятую / пробел / перевод строки
//
// Правила:
//  - работает одна "активная" база; остальные - запасные;
//  - если запрос упал по причине самой базы (нет соединения, таймаут, закончилось место/квота, остановлена,
//    только чтение), база на время считается нерабочей, активной становится следующая, запрос повторяется один раз;
//  - ошибки самих запросов (синтаксис, уникальность и т.п.) НЕ переключают базу;
//  - автоматического возврата назад нет: пока новая активная жива, пишем в неё (иначе данные разъехались бы);
//  - при старте выбирается база со свежим "пульсом" (meta.heartbeat пишется в активную раз в минуту), поэтому после
//    перезапуска Control не вернётся на устаревшую базу, которая ожила. DB_PREFER_PRIMARY=1 - всегда первая живая по списку;
//  - лёгкие таблицы (настройки мониторов, состояния) раз в 10 минут копируются из активной базы в запасные,
//    тяжёлая история (checks, crawl_changes ...) начинается на запасной с нуля.
const { Pool } = require('pg');

const HEARTBEAT_MS = 60 * 1000;
const SYNC_MS = 10 * 60 * 1000;
const DOWN_COOLDOWN_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 30000;

// что копируем в запасные базы (маленькие таблицы: настройки и текущие состояния)
const SYNC_TABLES = [
  'monitor_configs', 'monitor_state', 'ssl_status', 'domain_status',
  'trend_state', 'bot_queue_state', 'activity_state', 'crawl_state',
];

function parseUrls(env) {
  const list = [];
  const add = (u) => { u = String(u || '').trim(); if (u && !list.includes(u)) list.push(u); };
  add(env.DATABASE_URL);
  for (let i = 2; i <= 9; i++) add(env[`DATABASE_URL_${i}`]);
  String(env.DATABASE_URLS || '').split(/[\s,]+/).forEach(add);
  return list;
}

// pg считает sslmode=require/prefer/verify-ca в строке подключения синонимом verify-full и перекрывает им настройку ssl:
// облачные базы с собственным центром сертификации (Aiven и др.) тогда падают с "self-signed certificate in certificate chain".
// Поэтому параметры ssl* из адреса убираем и задаём TLS сами: шифрование есть, цепочка не проверяется
// (так же было и раньше для Neon). sslmode=disable оставляет соединение без TLS.
function sslFromUrl(raw) {
  try {
    const u = new URL(raw);
    const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'sslcompat']) u.searchParams.delete(k);
    return { url: u.toString(), ssl: mode === 'disable' ? false : { rejectUnauthorized: false } };
  } catch {
    return { url: raw, ssl: { rejectUnauthorized: false } };
  }
}

function labelOf(url, i) {
  try { const u = new URL(url); return `#${i + 1} ${u.hostname}`; } catch { return `#${i + 1}`; }
}

// Ошибка "базы", а не запроса: имеет смысл пробовать другую базу.
function isInfraError(e) {
  if (!e) return false;
  const code = String(e.code || '');
  const msg = String(e.message || '');
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|CERT_|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return true;
  if (/^(08|53|57P0|28|3D|25006)/.test(code)) return true; // соединение, ресурсы (диск, память, лимит подключений), остановка сервера, доступ, нет БД, только чтение
  return /connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT|Connection terminated|server closed the connection|too many (clients|connections)|quota|limit (has been )?exceeded|exceeded .*(limit|quota)|size limit|storage limit|compute time|project .*(suspend|disabled|deleted)|endpoint .*(disabled|suspend)|no space left|read-only transaction|could not extend file/i.test(msg);
}

class FailoverPool {
  constructor(urls, opts = {}) {
    this.log = opts.log || ((...a) => console.log('[db]', ...a));
    this.onSwitch = null;
    this.nodes = urls.map((url, i) => {
      const c = sslFromUrl(url);
      const pool = new Pool({
        connectionString: c.url,
        // Neon и большинство облачных Postgres требуют TLS (цепочка через их прокси)
        ssl: c.ssl,
        max: Number(process.env.DB_POOL_MAX) || 5,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
        idleTimeoutMillis: 30000,
      });
      // иначе ошибка на простаивающем соединении (Neon усыпил/оборвал) роняет весь процесс
      pool.on('error', (e) => this.log(`${labelOf(url, i)}: ошибка соединения: ${e.message}`));
      return { url, label: labelOf(url, i), pool, schemaOk: false, downUntil: 0, lastError: null, heartbeat: null };
    });
    this.active = this.nodes[0];
    this.applySchema = null;
    this.switching = null;
    this.timers = [];
  }

  // ---- запросы -------------------------------------------------------------
  async query(text, params) {
    let lastErr;
    for (let attempt = 0; attempt < this.nodes.length; attempt++) {
      const node = this.active;
      try {
        return await node.pool.query(text, params);
      } catch (e) {
        lastErr = e;
        if (this.nodes.length < 2 || !isInfraError(e)) throw e;
        const moved = await this._failover(node, e);
        if (!moved) throw e;
      }
    }
    throw lastErr;
  }

  // ---- переключение ----------------------------------------------------------
  async _failover(failed, err) {
    if (this.active !== failed) return true; // уже переключились (параллельный запрос)
    if (this.switching) return this.switching;
    this.switching = (async () => {
      failed.downUntil = Date.now() + DOWN_COOLDOWN_MS;
      failed.lastError = String(err && err.message || err).slice(0, 300);
      this.log(`${failed.label} недоступна: ${failed.lastError}`);
      for (const cand of this.nodes) {
        if (cand === failed || cand.downUntil > Date.now()) continue;
        try {
          await this._prepare(cand);
          this.active = cand;
          this.log(`переключились на ${cand.label}`);
          await this._beat();
          if (this.onSwitch) { try { await this.onSwitch(failed, cand, err); } catch (e) { this.log('onSwitch:', e.message); } }
          return true;
        } catch (e) {
          cand.downUntil = Date.now() + DOWN_COOLDOWN_MS;
          cand.lastError = String(e.message || e).slice(0, 300);
          this.log(`${cand.label} тоже недоступна: ${cand.lastError}`);
        }
      }
      this.log('нет ни одной рабочей базы');
      return false;
    })().finally(() => { this.switching = null; });
    return this.switching;
  }

  // проверить соединение и создать схему (один раз для базы)
  async _prepare(node) {
    await node.pool.query('SELECT 1');
    if (!node.schemaOk && this.applySchema) {
      await this.applySchema(node.pool);
      node.schemaOk = true;
    }
  }

  // ---- старт -----------------------------------------------------------------
  async start(applySchema) {
    this.applySchema = applySchema;
    const probes = await Promise.all(this.nodes.map(async (node) => {
      try {
        await node.pool.query('SELECT 1');
        let hb = 0;
        try {
          const r = await node.pool.query(`SELECT value FROM meta WHERE key = 'heartbeat'`);
          hb = r.rows[0] ? Number(r.rows[0].value) || 0 : 0;
        } catch { /* таблицы meta ещё нет: свежая база */ }
        node.heartbeat = hb;
        return { node, ok: true };
      } catch (e) {
        node.downUntil = Date.now() + DOWN_COOLDOWN_MS;
        node.lastError = String(e.message || e).slice(0, 300);
        this.log(`${node.label} недоступна при старте: ${node.lastError}`);
        return { node, ok: false };
      }
    }));
    const alive = probes.filter((p) => p.ok).map((p) => p.node);
    if (!alive.length) {
      // ни одна не ответила: работаем как раньше, ошибки покажет первый запрос
      this.active = this.nodes[0];
      this.nodes.forEach((n) => { n.downUntil = 0; });
      this.log('ни одна база не ответила при старте');
      const why = this.nodes.map((n) => `${n.label}: ${n.lastError}`).join('; ');
      throw new Error(`Ни одна база данных не отвечает. ${why}`);
    }
    const preferPrimary = /^(1|true|yes)$/i.test(process.env.DB_PREFER_PRIMARY || '');
    let best = alive[0];
    if (!preferPrimary) for (const n of alive) if ((n.heartbeat || 0) > (best.heartbeat || 0)) best = n;
    this.active = best;
    // схема на всех живых базах (запасные должны быть готовы заранее)
    for (const n of alive) {
      try { await this._prepare(n); } catch (e) { n.downUntil = Date.now() + DOWN_COOLDOWN_MS; n.lastError = String(e.message || e).slice(0, 300); this.log(`${n.label}: схема не создана: ${n.lastError}`); }
    }
    if (this.active.downUntil > Date.now()) { // схему на выбранной создать не удалось: берём любую готовую
      const ok = alive.find((n) => n.schemaOk);
      if (ok) this.active = ok;
    }
    this.log(`активная база: ${this.active.label}; всего баз: ${this.nodes.length}`);
    await this._beat();
    this._timers();
    this.sync().catch((e) => this.log('синхронизация:', e.message));
  }

  _timers() {
    const t1 = setInterval(() => this._beat().catch(() => {}), HEARTBEAT_MS);
    const t2 = setInterval(() => this.sync().catch((e) => this.log('синхронизация:', e.message)), SYNC_MS);
    t1.unref(); t2.unref();
    this.timers.push(t1, t2);
  }

  // "пульс": запись во включённую базу раз в минуту; заодно ловит смерть базы, пока Control простаивает
  async _beat() {
    try {
      const now = String(Date.now());
      await this.query(`INSERT INTO meta (key, value) VALUES ('heartbeat', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [now]);
      this.active.heartbeat = Number(now);
    } catch (e) { this.log('пульс не записан:', e.message); }
  }

  // ---- копирование лёгких таблиц в запасные базы -------------------------------
  async sync() {
    if (this.nodes.length < 2) return { copied: 0 };
    const src = this.active;
    let copied = 0;
    for (const dst of this.nodes) {
      if (dst === src || dst.downUntil > Date.now()) continue;
      try {
        await this._prepare(dst);
        for (const table of SYNC_TABLES) {
          // чтение идёт через query(): если источник умер, сработает переключение, а не ошибка "копирования"
          const rows = (await this.query(`SELECT * FROM ${table}`)).rows;
          if (this.active !== src) return { copied, aborted: true }; // активная база сменилась посреди копирования
          if (!rows.length) continue; // пустым источником запасную базу не затираем
          const cols = Object.keys(rows[0]);
          const client = await dst.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM ${table}`);
            for (const r of rows) {
              await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => r[c]));
            }
            await client.query('COMMIT');
            copied += rows.length;
          } catch (e) {
            try { await client.query('ROLLBACK'); } catch { /* ignore */ }
            throw e;
          } finally { client.release(); }
        }
        dst.lastSync = Date.now();
      } catch (e) {
        dst.lastError = String(e.message || e).slice(0, 300);
        this.log(`копирование в ${dst.label}: ${dst.lastError}`);
      }
    }
    return { copied };
  }

  status() {
    const now = Date.now();
    return this.nodes.map((n) => ({
      label: n.label,
      active: n === this.active,
      state: n === this.active ? 'active' : n.downUntil > now ? 'down' : 'standby',
      lastError: n.lastError,
      lastSync: n.lastSync || null,
      heartbeat: n.heartbeat,
    }));
  }

  // Для тестов и ручной проверки: сбросить признак "нерабочая" и проверить все базы заново
  async recheck() {
    for (const n of this.nodes) {
      if (n === this.active) continue;
      try { await this._prepare(n); n.downUntil = 0; n.lastError = null; } catch (e) { n.downUntil = Date.now() + DOWN_COOLDOWN_MS; n.lastError = String(e.message || e).slice(0, 300); }
    }
    return this.status();
  }
}

function create(env = process.env) {
  const urls = parseUrls(env);
  if (!urls.length) {
    throw new Error(
      'Не задан DATABASE_URL в переменных окружения. ' +
      'Создай бесплатную базу (neon.tech и др.) и укажи connection string сюда; запасные - DATABASE_URL_2, DATABASE_URL_3. См. README.'
    );
  }
  return new FailoverPool(urls);
}

module.exports = { create, parseUrls, sslFromUrl, isInfraError, FailoverPool, SYNC_TABLES };
