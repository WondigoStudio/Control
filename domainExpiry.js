// Domain Expiry Tracking — та же идея, что checkSSLCert/runSSLCheck в checker.js,
// только источник данных не TLS-хендшейк, а RDAP (структурированный JSON-протокол,
// пришедший на смену WHOIS — https://rdap.org сам находит нужный registry по домену).
//
// Почему это важнее SSL-варнинга: просроченный сертификат ломает HTTPS на пару
// часов до продления. Просроченный домен уходит на аукцион/удаляется регистратором —
// потерять его можно НАВСЕГДА, если не заметить вовремя.

const fetch = require('node-fetch');

function extractRootDomain(hostname) {
  // Грубое, но достаточное для большинства случаев извлечение домена
  // второго уровня (example.com из sub.example.com). Не учитывает составные
  // TLD вида .co.uk идеально, но для целей "не проморгать expiry" этого хватает —
  // RDAP-запрос по неверно урезанному домену просто вернёт 404, а не соврёт.
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

async function checkDomainExpiry(hostname, timeoutMs = 8000) {
  const domain = extractRootDomain(hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return { valid: false, error: `RDAP вернул HTTP ${res.status}`, domain };
    }

    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const expirationEvent = events.find((e) => e.eventAction === 'expiration');

    if (!expirationEvent || !expirationEvent.eventDate) {
      return { valid: false, error: 'В ответе RDAP не найдена дата истечения домена', domain };
    }

    const expiresAt = new Date(expirationEvent.eventDate).getTime();
    const daysLeft = Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24));

    return { valid: daysLeft > 0, expiresAt, daysLeft, domain };
  } catch (e) {
    clearTimeout(timer);
    return { valid: false, error: e.name === 'AbortError' ? 'Таймаут запроса к RDAP' : e.message, domain };
  }
}

module.exports = { checkDomainExpiry, extractRootDomain };
