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
const cheerio = require('cheerio');
const { URL } = require('url');
const {
  getCrawlPages, upsertCrawlPage, markCrawlPagesRemoved, insertCrawlChange,
  getCrawlState, setCrawlState, getCrawlImage, upsertCrawlImage, getCrawlImagesForPage,
} = require('./db');
const { notify } = require('./notifier');

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 40;
const FETCH_TIMEOUT_MS = 10000;
const MAX_IMAGES_PER_PAGE = 15;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|rar|7z|mp4|mp3|wav|woff2?|ttf|eot|otf)(\?|#|$)/i;

// Декодируем HTML-сущности в href перед тем, как превращать его в URL.
// Без этого "&amp;lang=ru" остаётся буквальным текстом, и при каждом
// следующем уровне обхода экранирование накапливается (&amp;amp%3B...),
// плодя бесконечные мусорные варианты одной и той же ссылки — классическая
// "ловушка краулера" на страницах с реф-параметрами (языковые переключатели,
// счётчики, метки и т.п.).
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// Доп. защита от "ловушек краулера": если у ссылки подозрительно много
// GET-параметров (сайт с реф-меткой/языковым переключателем, отражающей
// текущую строку запроса в каждую ссылку, легко плодит комбинаторный взрыв
// вариантов одной и той же страницы) — не идём туда вглубь, а считаем её
// потенциальным мусором и пропускаем.
const MAX_QUERY_PARAMS = 4;
function looksLikeCrawlerTrap(url) {
  try {
    const params = new URL(url).searchParams;
    let count = 0;
    for (const _ of params.keys()) count++;
    return count > MAX_QUERY_PARAMS;
  } catch (e) {
    return false;
  }
}

function normalizeUrl(rawUrl, base) {
  try {
    const u = new URL(decodeHtmlEntities(rawUrl), base);
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

// Извлечение ссылок через cheerio (вместо регэкспа) — заодно cheerio сам
// декодирует HTML-сущности в атрибутах при парсинге, так что нормальные
// "&amp;" в href больше не требуют отдельной обработки на этом этапе.
function extractLinksCheerio($, baseUrl) {
  const links = new Set();
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || href.trim().startsWith('#')) return;
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized && !SKIP_EXT.test(normalized)) links.add(normalized);
  });
  return [...links];
}

// Смысловые "блоки" страницы (заголовки, абзацы, пункты списков, ячейки
// таблиц) — то, что реально читает человек. Сравнивая эти блоки между двумя
// обходами (а не весь HTML целиком), можно точно сказать, что именно
// появилось и что исчезло, а не просто "страница изменилась на N%".
const CHUNK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,dt,dd';
const MAX_CHUNKS_PER_PAGE = 400;

function extractContentChunks($, $scope) {
  const chunks = [];
  const found = $scope.find(CHUNK_SELECTOR);
  // Если внутри области слежения вообще нет таких тегов (например, следим
  // за одним <span class="price">), берём текст самой области целиком —
  // хоть один смысловой блок для сравнения должен быть.
  const list = found.length ? found : $scope;
  list.each((i, el) => {
    if (chunks.length >= MAX_CHUNKS_PER_PAGE) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && text.length > 1 && text.length < 600) chunks.push(text);
  });
  return chunks;
}

// Сравнение как мультимножеств (порядок не важен) — находит, какие блоки
// появились, а какие пропали, даже если остальные блоки на странице просто
// переставили местами.
// Настоящий построчный diff (как в git) через классический LCS: находим
// самую длинную общую подпоследовательность блоков между старой и новой
// версией страницы, всё остальное размечаем как add/remove — с сохранением
// порядка, в отличие от простого сравнения множеств.
function lcsDiff(oldArr, newArr) {
  const n = oldArr.length, m = newArr.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldArr[i] === newArr[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldArr[i] === newArr[j]) { ops.push({ type: 'equal', text: oldArr[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'remove', text: oldArr[i] }); i++; }
    else { ops.push({ type: 'add', text: newArr[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'remove', text: oldArr[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', text: newArr[j] }); j++; }
  return ops;
}

// Сворачиваем длинные неизменные участки в маркер "...N неизменных блоков...",
// оставляя немного контекста (как git diff -U2) вокруг реальных изменений —
// иначе на длинной странице diff_json раздувается неизменными блоками,
// которые всё равно никого не интересуют.
const DIFF_CONTEXT = 2;
function buildHunks(ops) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.type !== 'equal') {
      for (let c = Math.max(0, k - DIFF_CONTEXT); c <= Math.min(ops.length - 1, k + DIFF_CONTEXT); c++) keep[c] = true;
    }
  });
  const result = [];
  let i = 0;
  while (i < ops.length) {
    if (keep[i]) { result.push(ops[i]); i++; }
    else {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      result.push({ type: 'context-skip', count: j - i });
      i = j;
    }
  }
  return result;
}

function truncateChunk(s) {
  return s.length > 70 ? s.slice(0, 67) + '…' : s;
}

function summarizeChunkDiff(added, removed, sizeDelta) {
  const parts = [];
  if (added.length) {
    const shown = added.slice(0, 5).map((s) => `«${truncateChunk(s)}»`).join(', ');
    parts.push(`➕ добавилось ${added.length}: ${shown}${added.length > 5 ? ` и ещё ${added.length - 5}` : ''}`);
  }
  if (removed.length) {
    const shown = removed.slice(0, 5).map((s) => `«${truncateChunk(s)}»`).join(', ');
    parts.push(`➖ исчезло ${removed.length}: ${shown}${removed.length > 5 ? ` и ещё ${removed.length - 5}` : ''}`);
  }
  if (!parts.length) {
    const sign = sizeDelta >= 0 ? '+' : '';
    return `изменилась разметка/оформление без видимых текстовых блоков (Δ${sign}${sizeDelta} симв.)`;
  }
  return parts.join(' · ');
}

function safeParseJsonArray(str) {
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

const HASH_SNAPSHOT_LIMIT = 20000; // чтобы не раздувать БД полными копиями страниц

// Когда hash изменился, но ни один отслеживаемый текстовый блок не поменялся
// (изменение где-то в разметке/атрибутах — например, случайный id, nonce,
// cache-busting параметр в src и т.п.) — ищем и показываем ТОЧНОЕ место
// расхождения в сыром HTML, чтобы не оставлять пользователя с одной лишь
// фразой "что-то изменилось" без единой зацепки, что именно.
function findFirstDiff(oldStr, newStr) {
  if (!oldStr || !newStr) return null;
  const len = Math.min(oldStr.length, newStr.length);
  let i = 0;
  while (i < len && oldStr[i] === newStr[i]) i++;
  if (i >= len && oldStr.length === newStr.length) return null;
  const start = Math.max(0, i - 30);
  return {
    index: i,
    oldCtx: oldStr.slice(start, i + 40),
    newCtx: newStr.slice(start, i + 40),
  };
}

// Картинки внутри области слежения — отслеживаем по hash самих байт файла
// (не HTML), чтобы заметить замену афиши/фото гостя, даже если окружающий
// текст не менялся ни на символ.
function extractImages($, $scope, baseUrl) {
  const urls = [];
  const seen = new Set();
  $scope.find('img').each((i, el) => {
    if (urls.length >= MAX_IMAGES_PER_PAGE) return;
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || src.trim().startsWith('data:')) return;
    const abs = normalizeUrl(src, baseUrl);
    if (abs && !seen.has(abs)) { seen.add(abs); urls.push(abs); }
  });
  return urls;
}

async function fetchImageHash(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.buffer();
    return crypto.createHash('sha256').update(buf).digest('hex');
  } finally {
    clearTimeout(timeout);
  }
}

// Нормализуем HTML перед хэшированием: убираем скрипты/стили (часто содержат
// таймстампы, csrf-токены, аналитику — меняются на каждой загрузке, но не
// являются реальным изменением контента) и схлопываем пробелы. Также убираем
// скрытые поля форм (<input type="hidden">) — там почти всегда лежит
// CSRF-токен или session id, который меняется на КАЖДОЙ загрузке страницы,
// даже если реальный контент не менялся ни на символ — без этой чистки
// краулер бы считал такую страницу "изменившейся" при каждом обходе.
// Убираем скрипты/стили/комментарии/скрытые CSRF-поля — то, что реально
// меняется на каждой загрузке, но не является изменением сайта. Отдельно от
// схлопывания пробелов, чтобы результат можно было использовать и для hash
// (после схлопывания), и для построчного diff (с сохранением строк).
function stripVolatile(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<input\b[^>]*\btype\s*=\s*["']hidden["'][^>]*>/gi, '')
    .replace(/<meta\b[^>]*\bname\s*=\s*["'][^"']*(csrf|token)[^"']*["'][^>]*>/gi, '');
}

function normalizeForHash(html) {
  return stripVolatile(html).replace(/\s+/g, ' ').trim();
}

function hashContent(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const MAX_DIFF_LINES = 600;
const MAX_DIFF_LINE_LENGTH = 400;

// Разбиваем очищенный HTML на псевдо-строки — по одной на границу тега
// (как простейший HTML-форматтер). Это даёт line-level представление кода
// страницы, по которому можно строить построчный diff вроде git — реагирует
// на ЛЮБОЕ изменение в коде (включая атрибуты тегов), а не только на текст.
function htmlToLines(html) {
  const spaced = html.replace(/></g, '>\n<');
  return spaced
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.length > MAX_DIFF_LINE_LENGTH ? line.slice(0, MAX_DIFF_LINE_LENGTH) + '…' : line))
    .slice(0, MAX_DIFF_LINES);
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
    const server = res.headers.get('server') || '';
    const setCookie = res.headers.get('set-cookie') || '';
    const finalUrl = res.url || url;
    if (!contentType.includes('text/html')) {
      return { statusCode: res.status, html: null, skipped: true, server, contentType, finalUrl };
    }
    const html = await res.text();
    return { statusCode: res.status, html, server, setCookie, finalUrl, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Обход через headless-браузер (Puppeteer) ---
// Нужен для сайтов с JS-антибот-челленджами (например, страница считает
// AES-хэш в JS и ставит cookie, прежде чем отдать настоящий контент) —
// обычный fetch() такое пройти не может в принципе, там нужен реальный
// JS-движок. Puppeteer — опциональная зависимость (см. package.json), чтобы
// не тянуть ~300 МБ Chromium туда, где он не нужен и может не собраться.

let browserModulePromise = null;
function loadPuppeteer() {
  if (!browserModulePromise) {
    browserModulePromise = Promise.resolve().then(() => require('puppeteer'));
  }
  return browserModulePromise;
}

async function launchBrowser() {
  const puppeteer = await loadPuppeteer();
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function fetchPageBrowser(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' });
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: FETCH_TIMEOUT_MS * 3 });
    // Многие JS-антибот-челленджи делают редирект/reload через секунду-две
    // после того, как посчитали cookie — даём странице немного времени
    // устояться перед тем, как забрать финальный HTML.
    await new Promise((r) => setTimeout(r, 1500));
    const html = await page.content();
    const statusCode = response ? response.status() : null;
    const finalUrl = page.url();
    return { statusCode, html, finalUrl, contentType: 'text/html' };
  } finally {
    await page.close().catch(() => {});
  }
}

// --- Живой прогресс обхода ---
// Отдельное in-memory хранилище (не в БД — это временное состояние только
// на время работы обхода), чтобы фронтенд мог опрашивать "что сейчас
// проверяется" чаще, чем обновляются финальные результаты, и подсвечивать
// текущую страницу на схеме прямо во время обхода.
const crawlProgress = {};

function getCrawlProgress(monitorId) {
  return crawlProgress[monitorId] || { running: false };
}

function setCrawlProgress(monitorId, patch) {
  crawlProgress[monitorId] = { ...(crawlProgress[monitorId] || {}), ...patch };
}

// Основной обход. monitor.crawl = { enabled, maxDepth, maxPages, sameHostOnly, intervalSec, useBrowser }
async function runCrawl(monitor) {
  const cfg = monitor.crawl || {};
  const maxDepth = Number.isFinite(cfg.maxDepth) ? cfg.maxDepth : DEFAULT_MAX_DEPTH;
  const maxPages = Number.isFinite(cfg.maxPages) ? cfg.maxPages : DEFAULT_MAX_PAGES;
  const sameHostOnly = cfg.sameHostOnly !== false;
  const useBrowser = !!cfg.useBrowser;

  const startUrl = normalizeUrl(monitor.url, monitor.url);
  if (!startUrl) return { ok: false, error: 'Некорректный стартовый URL' };
  const startHost = new URL(startUrl).hostname;

  const debugLog = [];
  const log = (msg) => debugLog.push(msg);
  log(`Старт обхода ${startUrl} · глубина=${maxDepth} · лимит страниц=${maxPages} · только тот же домен=${sameHostOnly ? 'да' : 'нет'} · режим=${useBrowser ? 'браузер (Puppeteer)' : 'обычный HTTP-запрос'}`);
  setCrawlProgress(monitor.id, { running: true, currentUrl: startUrl, visited: 0, startedAt: Date.now() });

  let browser = null;
  if (useBrowser) {
    try {
      browser = await launchBrowser();
    } catch (e) {
      log(`❌ не удалось запустить браузер для обхода: ${e.message}. Убедитесь, что установлена опциональная зависимость: npm install puppeteer`);
      await setCrawlState(monitor.id, Date.now(), 'error', 0, false, debugLog);
      return { ok: false, error: `Puppeteer недоступен: ${e.message}`, debugLog };
    }
  }

  try {
    return await crawlInternal(monitor, startUrl, startHost, maxDepth, maxPages, sameHostOnly, useBrowser, browser, debugLog, log);
  } catch (e) {
    log(`❌ обход прерван непредвиденной ошибкой: ${e.message}`);
    await setCrawlState(monitor.id, Date.now(), 'error', 0, false, debugLog);
    return { ok: false, error: e.message, debugLog };
  } finally {
    if (browser) await browser.close().catch(() => {});
    setCrawlProgress(monitor.id, { running: false, currentUrl: null });
  }
}

async function crawlInternal(monitor, startUrl, startHost, maxDepth, maxPages, sameHostOnly, useBrowser, browser, debugLog, log) {
  const cfg = monitor.crawl || {};

  const existingPages = await getCrawlPages(monitor.id);
  const previousHashes = new Map(existingPages.map((p) => [p.url, p.content_hash]));

  const visited = new Set();
  const queue = [{ url: startUrl, parent: null, depth: 0 }];
  const runTs = Date.now();

  const changes = { new: [], changed: [], errors: 0, imagesChanged: 0, imagesNew: 0 };
  let truncated = false;

  while (queue.length) {
    if (visited.size >= maxPages) {
      truncated = queue.length > 0;
      break;
    }
    const { url, parent, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    setCrawlProgress(monitor.id, { running: true, currentUrl: url, visited: visited.size, queued: queue.length });

    let result;
    try {
      result = useBrowser ? await fetchPageBrowser(browser, url) : await fetchPage(url);
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

    // --- Парсинг через cheerio: заголовок, область слежения (весь <body>
    // или конкретный CSS-селектор из настроек), ссылки, смысловые блоки для
    // diff'а, картинки. Если парсинг вдруг упал — откатываемся на старые
    // регэксп-версии, чтобы обход всё равно не остановился.
    const watchSelector = (cfg.watchSelector || '').trim();
    const ignoreSelectors = (cfg.ignoreSelectors || '').split(',').map((s) => s.trim()).filter(Boolean);
    let $ = null;
    let title = null;
    let scopedHtmlForHash = result.html;
    let newChunks = [];
    let imgUrls = [];
    let links = [];
    try {
      $ = cheerio.load(result.html);
      title = ($('title').first().text() || '').trim().slice(0, 200) || null;
      // Ссылки и картинки собираем ДО удаления игнорируемых блоков — если
      // кто-то по ошибке исключит из слежки блок с реальной навигацией,
      // обход всё равно не должен рвать связи графа.
      if (cfg.trackImages) imgUrls = extractImages($, $('body').length ? $('body') : $.root(), url);
      links = extractLinksCheerio($, url);

      let $scope = $('body').length ? $('body') : $.root();
      if (watchSelector) {
        const matched = $(watchSelector);
        if (matched.length) {
          $scope = matched.first();
        } else {
          log(`⚠️ CSS-селектор "${watchSelector}" не найден на ${url} — слежу за всей страницей целиком в этот раз`);
        }
      }
      // Вырезаем заведомо "шумные" блоки (таймеры, счётчики и т.п.) ПОСЛЕ
      // выбора области слежения, но ДО подсчёта hash/diff — они реально
      // меняются на каждой загрузке страницы, но это не значит, что сайт
      // изменился.
      if (ignoreSelectors.length) {
        ignoreSelectors.forEach((sel) => {
          try { $scope.find(sel).remove(); } catch (e) { log(`⚠️ некорректный игнорируемый селектор "${sel}": ${e.message}`); }
        });
      }
      scopedHtmlForHash = $.html($scope);
      newChunks = extractContentChunks($, $scope);
    } catch (e) {
      log(`⚠️ не удалось разобрать HTML через cheerio на ${url} (${e.message}) — считаю без учёта CSS-селектора`);
      title = extractTitle(result.html);
      links = extractLinks(result.html, url);
    }

    const stripped = stripVolatile(scopedHtmlForHash);
    const normalized = stripped.replace(/\s+/g, ' ').trim();
    const rawLines = htmlToLines(stripped);
    const hash = hashContent(normalized);
    const prevHash = previousHashes.get(url);
    const prevPage = existingPages.find((p) => p.url === url);
    const prevChunks = prevPage && prevPage.items_json ? safeParseJsonArray(prevPage.items_json) : null;
    const prevRawLines = prevPage && prevPage.raw_lines_json ? safeParseJsonArray(prevPage.raw_lines_json) : null;

    let status;
    if (prevHash === undefined) {
      status = 'new';
      changes.new.push(url);
      await insertCrawlChange(monitor.id, url, runTs, 'new', null, hash, `Новая страница обнаружена: ${title || url}`);
    } else if (prevHash !== hash) {
      status = 'changed';
      changes.changed.push(url);
      const sizeDelta = normalized.length - (prevPage ? (prevPage.content_length || 0) : 0);
      let summary;

      // Построчный diff строим ВСЕГДА по сырому HTML-коду (не только по
      // видимому тексту) — так видно вообще любое изменение: текст,
      // атрибуты тегов, структуру. Раньше diff строился только по
      // смысловым текстовым блокам и пропадал, если менялась разметка.
      let diffJson = null;
      if (prevRawLines) {
        const lineOps = lcsDiff(prevRawLines, rawLines);
        const hasLineDiff = lineOps.some((o) => o.type !== 'equal');
        if (hasLineDiff) diffJson = JSON.stringify(buildHunks(lineOps));
      }

      if (prevChunks) {
        const ops = lcsDiff(prevChunks, newChunks);
        const added = ops.filter((o) => o.type === 'add').map((o) => o.text);
        const removed = ops.filter((o) => o.type === 'remove').map((o) => o.text);
        summary = summarizeChunkDiff(added, removed, sizeDelta);
        // Диагностика: hash изменился, но ни один отслеживаемый текстовый
        // блок — нет. Значит разница где-то в разметке/атрибутах (или в
        // блоке, который стоило бы исключить через "ignoreSelectors").
        // Построчный diff кода (diffJson выше) в этом случае и покажет,
        // что именно поменялось — тут просто поясняем словами.
        if (added.length === 0 && removed.length === 0 && prevPage && prevPage.hash_snapshot) {
          const diff = findFirstDiff(prevPage.hash_snapshot, normalized);
          if (diff) {
            summary += ` · место расхождения в разметке: было "…${diff.oldCtx}…" стало "…${diff.newCtx}…" — полный построчный diff кода см. на странице "подробнее". Если это что-то постоянно меняющееся (таймер, счётчик и т.п.), исключи его через "Исключить из слежки" в настройках`;
          }
        }
      } else {
        const sign = sizeDelta >= 0 ? '+' : '';
        summary = `Контент изменился (размер ${sign}${sizeDelta} симв.)`;
      }
      await insertCrawlChange(monitor.id, url, runTs, 'changed', prevHash, hash, summary, diffJson);
    } else {
      status = 'unchanged';
    }

    await upsertCrawlPage(monitor.id, url, parent, depth, title, result.statusCode, hash, normalized.length, status, null, JSON.stringify(newChunks), normalized.slice(0, HASH_SNAPSHOT_LIMIT), JSON.stringify(rawLines));
    // Отдельно от currentUrl (которое двигает "живое" кольцо на следующую
    // страницу) — фиксируем итоговый статус только что обработанной
    // страницы, чтобы фронтенд мог сразу перекрасить именно её узел, не
    // дожидаясь следующей полной перерисовки графа.
    setCrawlProgress(monitor.id, { lastPageUrl: url, lastPageStatus: status, lastPageTs: Date.now() });

    // Картинки проверяем независимо от того, поменялся ли текст страницы —
    // афишу могли заменить, ничего не тронув в остальной вёрстке.
    if (cfg.trackImages && imgUrls.length) {
      // Если для этой страницы раньше вообще не отслеживалось ни одной
      // картинки (например, слежку за картинками только что включили на
      // уже давно обходимом сайте) — это установка базовой линии, а не
      // поток "новых картинок". Иначе включение галочки на сайте с
      // десятками страниц устраивает лавину уведомлений на ровном месте.
      const existingImgs = await getCrawlImagesForPage(monitor.id, url);
      const hasBaseline = existingImgs.length > 0;

      let imgChanged = 0, imgNew = 0;
      for (const imgUrl of imgUrls) {
        try {
          const imgHash = await fetchImageHash(imgUrl);
          const prevImg = await getCrawlImage(monitor.id, url, imgUrl);
          const imgStatus = !prevImg ? 'new' : (prevImg.content_hash !== imgHash ? 'changed' : 'unchanged');
          await upsertCrawlImage(monitor.id, url, imgUrl, imgHash, imgStatus, null);
          if (imgStatus === 'changed') {
            imgChanged++;
            changes.imagesChanged++;
            await insertCrawlChange(monitor.id, url, runTs, 'image_changed', prevImg.content_hash, imgHash, `Картинка изменилась: ${imgUrl}`);
          } else if (imgStatus === 'new' && status !== 'new' && hasBaseline) {
            // Новую картинку отдельно отмечаем, только если у страницы уже
            // была база для сравнения — иначе на каждой впервые
            // просканированной странице будет спам из "новая картинка" по
            // числу всех картинок на ней.
            imgNew++;
            changes.imagesNew++;
            await insertCrawlChange(monitor.id, url, runTs, 'image_new', null, imgHash, `Новая картинка на странице: ${imgUrl}`);
          }
        } catch (e) {
          // не страшно — просто эта картинка не проверилась в этот раз
        }
      }
      if (imgChanged || imgNew) log(`${url}: картинок изменилось ${imgChanged}, новых ${imgNew}`);
    }

    if (depth < maxDepth) {
      let addedToQueue = 0;
      let trapsSkipped = 0;
      for (const link of links) {
        if (visited.has(link)) continue;
        if (sameHostOnly && new URL(link).hostname !== startHost) continue;
        if (looksLikeCrawlerTrap(link)) { trapsSkipped++; continue; }
        queue.push({ url: link, parent: url, depth: depth + 1 });
        addedToQueue++;
      }
      log(`${url} (глубина ${depth}) → статус ${result.statusCode}, html ${result.html.length} симв., ссылок найдено ${links.length}, добавлено в очередь ${addedToQueue}${trapsSkipped ? `, пропущено как вероятная URL-ловушка ${trapsSkipped}` : ''}`);
      // Если ссылок аномально мало для полученного объёма HTML — скорее всего
      // это не настоящая страница, а анти-бот заглушка/JS-челлендж хостинга.
      // Печатаем кусок реального ответа, чтобы это было видно без доступа
      // к консоли сервера.
      if (links.length === 0 && result.html.length < 5000) {
        const snippet = result.html.replace(/\s+/g, ' ').trim().slice(0, 400);
        log(`⚠️ подозрительно короткий ответ без ссылок — сервер: "${result.server || '—'}", итоговый URL: ${result.finalUrl}${result.setCookie ? ', выставил Set-Cookie (похоже на антибот-челлендж)' : ''}`);
        log(`⚠️ вот что реально пришло: "${snippet}${result.html.length > 400 ? '…' : ''}"`);
      }
    }
  }

  // Только если обход не был искусственно оборван лимитом страниц — иначе
  // легко пометить "удалёнными" страницы, до которых просто не дошли в этот
  // раз, хотя они никуда не делись.
  let removed = [];
  if (!truncated) {
    removed = (await markCrawlPagesRemoved(monitor.id, [...visited], runTs)) || [];
  }

  log(`Готово: страниц просмотрено ${visited.size}, новых ${changes.new.length}, изменилось ${changes.changed.length}, исчезло ${removed.length}, ошибок ${changes.errors}, картинок изменилось ${changes.imagesChanged}, новых картинок ${changes.imagesNew}${truncated ? ' (упёрлись в лимит страниц)' : ''}`);

  await setCrawlState(monitor.id, runTs, 'ok', visited.size, truncated, debugLog);

  const hasChanges = changes.new.length > 0 || changes.changed.length > 0 || removed.length > 0 || changes.imagesChanged > 0 || changes.imagesNew > 0;
  if (hasChanges && cfg.notifyOnChange !== false) {
    const lines = [];
    if (changes.new.length) lines.push(`🆕 Новых страниц: ${changes.new.length}`);
    if (changes.changed.length) lines.push(`✏️ Изменённых страниц: ${changes.changed.length}`);
    if (removed.length) lines.push(`🗑 Исчезнувших страниц: ${removed.length}`);
    if (changes.imagesChanged) lines.push(`🖼 Изменённых картинок: ${changes.imagesChanged}`);
    if (changes.imagesNew) lines.push(`🖼 Новых картинок: ${changes.imagesNew}`);
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
    imagesChangedCount: changes.imagesChanged,
    imagesNewCount: changes.imagesNew,
    debugLog,
  };
}

module.exports = { runCrawl, normalizeUrl, diffSummary, getCrawlProgress };
