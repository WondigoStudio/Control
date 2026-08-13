// Пошаговое расследование инцидента: DNS → TCP → TLS → HTTP.
//
// В отличие от diagnosis.js (который постфактум классифицирует ОДНУ ошибку
// по тексту), этот модуль реально выполняет каждый шаг сети по отдельности
// и честно репортит, где именно случился обрыв. Если DNS резолвится, но TCP
// не коннектится — мы это ЗНАЕМ, а не гадаем по regexp.
//
// Важно: это дорогая операция (до 3 доп. сетевых round-trip'ов), поэтому
// вызывать её нужно только при реальном инциденте (статус сменился на down),
// а не на каждый обычный тик проверки — см. checker.js.

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const fetch = require('node-fetch');

const STEP = {
  OK: 'ok',
  FAIL: 'fail',
  SKIPPED: 'skipped', // шаг не выполнялся (например, TLS для http:// адреса)
};

function step(status, detail, ms) {
  return { status, detail, ms: ms ?? null };
}

async function probeDns(hostname) {
  const start = Date.now();
  try {
    const addresses = await dns.resolve4(hostname).catch(() => dns.resolve6(hostname));
    return step(STEP.OK, addresses.slice(0, 3).join(', '), Date.now() - start);
  } catch (e) {
    return step(STEP.FAIL, e.code || e.message, Date.now() - start);
  }
}

function probeTcp(hostname, port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: timeoutMs });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => finish(step(STEP.OK, `подключено к ${hostname}:${port}`, Date.now() - start)));
    socket.on('timeout', () => finish(step(STEP.FAIL, 'таймаут подключения', Date.now() - start)));
    socket.on('error', (e) => finish(step(STEP.FAIL, e.code || e.message, Date.now() - start)));
  });
}

function probeTls(hostname, port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const authorized = socket.authorized;
        const cert = socket.getPeerCertificate();
        socket.end();
        const daysLeft = cert && cert.valid_to ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000) : null;
        resolve(
          step(
            authorized ? STEP.OK : STEP.FAIL,
            authorized ? `валиден, истекает через ${daysLeft} дн.` : (socket.authorizationError || 'сертификат не прошёл проверку'),
            Date.now() - start
          )
        );
      }
    );
    socket.on('error', (e) => resolve(step(STEP.FAIL, e.code || e.message, Date.now() - start)));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(step(STEP.FAIL, 'таймаут TLS handshake', Date.now() - start));
    });
  });
}

async function probeHttp(url, timeoutMs) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const ms = Date.now() - start;
    const ok = res.status < 500;
    return step(ok ? STEP.OK : STEP.FAIL, `HTTP ${res.status}`, ms);
  } catch (e) {
    return step(STEP.FAIL, e.name === 'AbortError' ? 'таймаут' : e.message, Date.now() - start);
  }
}

// Выполняет полное расследование по шагам, останавливаясь на первом
// провале (нет смысла проверять TLS, если TCP не подключился) —
// последующие шаги помечаются как SKIPPED, а не молча опускаются,
// чтобы в Evidence было видно, что они не выполнялись.
async function runDiagnosticProbe(monitorUrl, timeoutMs = 8000) {
  const parsed = new URL(monitorUrl);
  const hostname = parsed.hostname;
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);

  const evidence = { dns: null, tcp: null, tls: null, http: null, hostname, port };

  evidence.dns = await probeDns(hostname);
  if (evidence.dns.status !== STEP.OK) {
    evidence.tcp = step(STEP.SKIPPED, 'пропущено — DNS не резолвится');
    evidence.tls = step(STEP.SKIPPED, 'пропущено — DNS не резолвится');
    evidence.http = step(STEP.SKIPPED, 'пропущено — DNS не резолвится');
    return evidence;
  }

  evidence.tcp = await probeTcp(hostname, port, timeoutMs);
  if (evidence.tcp.status !== STEP.OK) {
    evidence.tls = step(STEP.SKIPPED, 'пропущено — TCP не подключился');
    evidence.http = step(STEP.SKIPPED, 'пропущено — TCP не подключился');
    return evidence;
  }

  if (isHttps) {
    evidence.tls = await probeTls(hostname, port, timeoutMs);
    // TLS-провал не блокирует HTTP-шаг — иногда полезно узнать, что дальше
    // ошибки сертификата сервер вообще не отвечает по содержанию.
  } else {
    evidence.tls = step(STEP.SKIPPED, 'не применимо — обычный HTTP без TLS');
  }

  evidence.http = await probeHttp(monitorUrl, timeoutMs);

  return evidence;
}

function formatEvidenceBlock(evidence, extra) {
  // extra: { locations: [{label, ok, responseMs, error}], hosting, conclusion, recoveryStatus, action }
  const icon = (s) => (s === STEP.OK ? '✓' : s === STEP.FAIL ? '✗' : '—');
  const lines = [];
  lines.push('Evidence:');
  lines.push('');
  lines.push(`DNS:  ${icon(evidence.dns.status)} ${evidence.dns.detail}${evidence.dns.ms !== null ? ` (${evidence.dns.ms}мс)` : ''}`);
  lines.push(`TCP:  ${icon(evidence.tcp.status)} ${evidence.tcp.detail}${evidence.tcp.ms !== null ? ` (${evidence.tcp.ms}мс)` : ''}`);
  lines.push(`TLS:  ${icon(evidence.tls.status)} ${evidence.tls.detail}${evidence.tls.ms !== null ? ` (${evidence.tls.ms}мс)` : ''}`);
  lines.push(`HTTP: ${icon(evidence.http.status)} ${evidence.http.detail}${evidence.http.ms !== null ? ` (${evidence.http.ms}мс)` : ''}`);

  if (extra && extra.locations && extra.locations.length) {
    lines.push('');
    lines.push('Other locations:');
    for (const loc of extra.locations) {
      lines.push(`  ${loc.label}: ${loc.ok === true ? '✓' : loc.ok === false ? '✗' : '—'}`);
    }
  }

  if (extra && extra.hosting) {
    lines.push('');
    lines.push(`Hosting: ${extra.hosting}`);
  }

  if (extra && extra.conclusion) {
    lines.push('');
    lines.push(`Conclusion: ${extra.conclusion}`);
  }

  if (extra && extra.recoveryStatus) {
    lines.push('');
    lines.push(`Recovery: ${extra.recoveryStatus}`);
  }

  if (extra && extra.action) {
    lines.push(`Action: ${extra.action}`);
  }

  return lines.join('\n');
}

module.exports = { runDiagnosticProbe, formatEvidenceBlock, STEP };
