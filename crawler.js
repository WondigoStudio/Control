// crawler.js — «Паутина»: полноценная слежка за изменениями на сайте.
//
// Идея: берём стартовую страницу монитора, вытаскиваем из неё все ссылки на
// тот же домен, у каждой из них снова вытаскиваем ссылки — и так вглубь до
// заданного лимита (maxDepth / maxPages). Для каждой найденной страницы
// считаем hash её содержимого (без <script>/<style> и лишних пробелов, чтобы
// не ловить ложные срабатывания от таймстампов и аналитики). При следующем
// обходе сравниваем hash с предыдущим — так узнаём new / changed / unchanged /
// removed. Получается что-то вроде радара, расползающегося по сайту слоями —
// отсюда и «паутина» во фронтенде (radial-граф по depth).

const fetch = require('node-fetch');
const crypto = require('crypto');
const { URL } = require('url');
const {
  getCrawlPages, upsertCrawlPage, markCrawlPagesRemoved, insertCrawlChange,
  getCrawlState, setCrawlState,
} = require('./db');
const { notify } = require('./notifier');

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 40;
const FETCH_TIMEOUT_MS = 10000;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|rar|7z|mp4|mp3|wav|woff2?|ttf|eot|otf)(\?|#|$)/i;

function normalizeUrl(rawUrl, base) {
  try {
    const u = new URL(rawUrl, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    // убираем висячий "/" в конце, кроме корня — иначе /about и /about/
    // считались бы разными страницами без причины
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch (e) {
    return null;
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /<a\s+[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const normalized = normalizeUrl(m[1], baseUrl);
    if (normalized && !SKIP_EXT.test(normalized)) links.add(normalized);
  }
  return [...links];
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim().slice(0, 200) : null;
}

// Нормализуем HTML перед хэшированием: убираем скрипты/стили (часто содержат
// таймстампы, csrf-токены, аналитику — меняются на каждой загрузке, но не
// являются реальным изменением контента) и схлопываем пробелы.
function normalizeForHash(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashContent(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Грубая оценка "насколько сильно изменилась страница" через сравнение
// множеств слов (Jaccard) — дёшево, без внешних diff-библиотек, но неплохо
// отличает "поправили опечатку" от "переписали страницу".
function diffSummary(oldNormalized, newNormalized) {
  const wordsOld = new Set(oldNormalized.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsNew = new Set(newNormalized.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  let intersection = 0;
  for (const w of wordsOld) if (wordsNew.has(w)) intersection++;
  const union = wordsOld.size + wordsNew.size - intersection;
  const similarity = union === 0 ? 1 : intersection / union;
  const changedPct = Math.round((1 - similarity) * 1000) / 10;
  const sizeDelta = newNormalized.length - oldNormalized.length;
  const sizeSign = sizeDelta >= 0 ? '+' : '';
  return `~${changedPct}% содержимого изменилось, размер ${sizeSign}${sizeDelta} симв.`;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return { statusCode: res.status, html: null, skipped: true };
    }
    const html = await res.text();
    return { statusCode: res.status, html };
  } finally {
    clearTimeout(timeout);
  }
}

// Основной обход. monitor.crawl = { enabled, maxDepth, maxPages, sameHostOnly, intervalSec }
async function runCrawl(monitor) {
  const cfg = monitor.crawl || {};
  const maxDepth = Number.isFinite(cfg.maxDepth) ? cfg.maxDepth : DEFAULT_MAX_DEPTH;
  const maxPages = Number.isFinite(cfg.maxPages) ? cfg.maxPages : DEFAULT_MAX_PAGES;
  const sameHostOnly = cfg.sameHostOnly !== false;

  const startUrl = normalizeUrl(monitor.url, monitor.url);
  if (!startUrl) return { ok: false, error: 'Некорректный стартовый URL' };
  const startHost = new URL(startUrl).hostname;

  const debugLog = [];
  const log = (msg) => debugLog.push(msg);
  log(`Старт обхода ${startUrl} · глубина=${maxDepth} · лимит страниц=${maxPages} · только тот же домен=${sameHostOnly ? 'да' : 'нет'}`);

  try {
    return await crawlInternal(monitor, startUrl, startHost, maxDepth, maxPages, sameHostOnly, debugLog, log);
  } catch (e) {
    log(`❌ обход прерван непредвиденной ошибкой: ${e.message}`);
    await setCrawlState(monitor.id, Date.now(), 'error', 0, false, debugLog);
    return { ok: false, error: e.message, debugLog };
  }
}

async function crawlInternal(monitor, startUrl, startHost, maxDepth, maxPages, sameHostOnly, debugLog, log) {
  const cfg = monitor.crawl || {};

  const existingPages = await getCrawlPages(monitor.id);
  const previousHashes = new Map(existingPages.map((p) => [p.url, p.content_hash]));

  const visited = new Set();
  const queue = [{ url: startUrl, parent: null, depth: 0 }];
  const runTs = Date.now();

  const changes = { new: [], changed: [], errors: 0 };
  let truncated = false;

  while (queue.length) {
    if (visited.size >= maxPages) {
      truncated = queue.length > 0;
      break;
    }
    const { url, parent, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let result;
    try {
      result = await fetchPage(url);
    } catch (e) {
      await upsertCrawlPage(monitor.id, url, parent, depth, null, null, null, null, 'error', e.message);
      log(`❌ ошибка загрузки ${url} — ${e.message}`);
      changes.errors++;
      continue;
    }

    if (result.skipped || !result.html) {
      await upsertCrawlPage(monitor.id, url, parent, depth, null, result.statusCode, null, null, 'unchanged', `Пропущено: content-type не text/html (код ${result.statusCode})`);
      log(`⚠️ пропущена ${url} — не HTML (статус ответа ${result.statusCode})`);
      continue;
    }

    const normalized = normalizeForHash(result.html);
    const hash = hashContent(normalized);
    const title = extractTitle(result.html);
    const prevHash = previousHashes.get(url);

    let status;
    if (prevHash === undefined) {
      status = 'new';
      changes.new.push(url);
      await insertCrawlChange(monitor.id, url, runTs, 'new', null, hash, `Новая страница обнаружена: ${title || url}`);
    } else if (prevHash !== hash) {
      status = 'changed';
      changes.changed.push(url);
      // Для diff нужен предыдущий нормализованный текст, но мы храним только
      // hash — сравниваем по длине через content_length записи (грубее, но
      // без второго хранения полного HTML на каждую страницу).
      const prevPage = existingPages.find((p) => p.url === url);
      const prevLenGuess = prevPage ? (prevPage.content_length || 0) : 0;
      const sizeDelta = normalized.length - prevLenGuess;
      const sign = sizeDelta >= 0 ? '+' : '';
      await insertCrawlChange(monitor.id, url, runTs, 'changed', prevHash, hash, `Контент изменился (размер ${sign}${sizeDelta} симв.)`);
    } else {
      status = 'unchanged';
    }

    await upsertCrawlPage(monitor.id, url, parent, depth, title, result.statusCode, hash, normalized.length, status, null);

    if (depth < maxDepth) {
      const links = extractLinks(result.html, url);
      let addedToQueue = 0;
      for (const link of links) {
        if (visited.has(link)) continue;
        if (sameHostOnly && new URL(link).hostname !== startHost) continue;
        queue.push({ url: link, parent: url, depth: depth + 1 });
        addedToQueue++;
      }
      log(`${url} (глубина ${depth}) → статус ${result.statusCode}, html ${result.html.length} симв., ссылок найдено ${links.length}, добавлено в очередь ${addedToQueue}`);
    }
  }

  // Только если обход не был искусственно оборван лимитом страниц — иначе
  // легко пометить "удалёнными" страницы, до которых просто не дошли в этот
  // раз, хотя они никуда не делись.
  let removed = [];
  if (!truncated) {
    removed = (await markCrawlPagesRemoved(monitor.id, [...visited], runTs)) || [];
  }

  log(`Готово: страниц просмотрено ${visited.size}, новых ${changes.new.length}, изменилось ${changes.changed.length}, исчезло ${removed.length}, ошибок ${changes.errors}${truncated ? ' (упёрлись в лимит страниц)' : ''}`);

  await setCrawlState(monitor.id, runTs, 'ok', visited.size, truncated, debugLog);

  const hasChanges = changes.new.length > 0 || changes.changed.length > 0 || removed.length > 0;
  if (hasChanges && cfg.notifyOnChange !== false) {
    const lines = [];
    if (changes.new.length) lines.push(`🆕 Новых страниц: ${changes.new.length}`);
    if (changes.changed.length) lines.push(`✏️ Изменённых страниц: ${changes.changed.length}`);
    if (removed.length) lines.push(`🗑 Исчезнувших страниц: ${removed.length}`);
    await notify(
      `🕸 Обнаружены изменения на сайте: ${monitor.name}`,
      `Обход паутины для "${monitor.name}" (${startUrl}) нашёл изменения:\n${lines.join('\n')}\n\nВсего просмотрено страниц: ${visited.size}${truncated ? ' (обход не завершён — упёрлись в лимит страниц)' : ''}.`
    );
  }

  return {
    ok: true,
    pagesVisited: visited.size,
    truncated,
    newCount: changes.new.length,
    changedCount: changes.changed.length,
    removedCount: removed.length,
    errorCount: changes.errors,
    debugLog,
  };
}

module.exports = { runCrawl, normalizeUrl, diffSummary };
