const http = require('http');
const https = require('https');
const { URL } = require('url');

// Выполняет HTTP(S)-запрос через низкоуровневые модули Node,
// чтобы зафиксировать время каждого этапа: DNS, TCP-подключение, TLS, ответ сервера.
function timingFetch(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const start = Date.now();
    const marks = { dns: null, tcp: null, tls: null, ttfb: null, total: null };

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'StatusMonitor/1.0' },
        timeout: timeoutMs,
      },
      (res) => {
        marks.ttfb = Date.now() - start;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          marks.total = Date.now() - start;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
            timing: marks,
          });
        });
      }
    );

    req.on('socket', (socket) => {
      socket.on('lookup', () => { marks.dns = Date.now() - start; });
      socket.on('connect', () => { marks.tcp = Date.now() - start; });
      socket.on('secureConnect', () => { marks.tls = Date.now() - start; });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Таймаут подключения'));
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

module.exports = { timingFetch };
