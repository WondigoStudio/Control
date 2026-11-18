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
  getCrawlPages, upsertCrawlPage, insertCrawlChange, touchCrawlPage, touchCrawlPageError,
  setCrawlPageMissed, setCrawlPagePending, markCrawlPageRemoved,
  getCrawlState, setCrawlState, getCrawlImage, upsertCrawlImage, getCrawlImagesForPage,
} = require('./db');
const { notify } = require('./notifier');

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 40;
const FETCH_TIMEOUT_MS = 20000;
// Сбой одной загрузки (таймаут, обрыв, 5xx, 429) не должен превращаться в "страница изменилась/исчезла":
// сначала повторяем запрос с паузой, и только потом считаем страницу недоступной в этот обход.
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1500, 4000];
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const CONFIRM_DELAY_MS = 2500;      // пауза перед повторной загрузкой для подтверждения изменения
const DEFAULT_REMOVE_AFTER = 2;     // сколько обходов подряд страница должна отвечать 404/410, чтобы считаться удалённой
const MAX_ORPHAN_CHECKS = 60;       // сколько "не найденных по ссылкам" страниц проверять напрямую за обход
// Способ подсчёта hash. Если он меняется, сохранённые hash несравнимы: страницы тихо переучиваются
// (без события "изменилась"). 2 = по видимому тексту и ссылкам, 21 = по разметке (hashMode: 'markup').
const HASH_VERSION_TEXT = 2;
const HASH_VERSION_MARKUP = 21;
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|yclid|ymclid|_openstat|mc_cid|mc_eid|_ga|_gl|igshid|mkt_tok|msclkid|ttclid|srsltid)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    // Метки аналитики (utm_*, fbclid, ...) не меняют страницу, но дают бесконечно много "новых" адресов
    // и "исчезнувших" старых. Выкидываем их и упорядочиваем остальные параметры.
    if (u.search) {
      const keep = [];
      for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) keep.push([k, v]);
      keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      u.search = keep.length ? new URLSearchParams(keep).toString() : '';
    }
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
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    if (!contentType.includes('text/html')) {
      return { statusCode: res.status, html: null, skipped: true, server, contentType, finalUrl, retryAfter };
    }
    const html = await res.text();
    return { statusCode: res.status, html, server, setCookie, finalUrl, contentType, retryAfter };
  } finally {
    clearTimeout(timeout);
  }
}


// --- Устойчивая загрузка и разбор страницы ---

// Повторяет загрузку при временных сбоях (сеть, таймаут, 5xx, 429). Возвращает последний результат или бросает
// последнюю ошибку, если все попытки закончились исключением.
async function fetchRetry(fetcher, url, log, attempts = FETCH_ATTEMPTS) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetcher(url);
      if (r.statusCode == null || !TRANSIENT_STATUS.has(r.statusCode)) return r;
      last = { result: r };
    } catch (e) {
      last = { error: e };
    }
    if (i < attempts - 1) {
      const ra = last.result && Number.isFinite(last.result.retryAfter) ? Math.min(last.result.retryAfter, 10) * 1000 : 0;
      const wait = Math.max(ra, RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]) + Math.floor(Math.random() * 400);
      if (log) log(`↻ ${url}: ${last.error ? last.error.message : `HTTP ${last.result.statusCode}`}, повтор ${i + 2}/${attempts} через ${Math.round(wait / 1000)} с`);
      await sleep(wait);
    }
  }
  if (last.error) throw last.error;
  return last.result;
}

// Заглушки антибот-защит и страницы "доступ запрещён", которые приходят с кодом 200. Их содержимое нельзя
// считать содержимым сайта: иначе страница то "изменилась" на заглушку, то обратно.
const BLOCK_PAGE_RE = /(just a moment|attention required|checking your browser|enable javascript and cookies|access denied|request blocked|ddos[- ]guard|are you (a )?(human|robot)|подтвердите,? что вы не робот|проверка браузера|доступ (к сайту )?(ограничен|запрещ))/i;
function looksLikeBlockPage(html) {
  if (!html || html.length > 30000) return false;
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '';
  if (BLOCK_PAGE_RE.test(title)) return true;
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return text.length < 1200 && BLOCK_PAGE_RE.test(text);
}

// ok | gone (404/410) | error (прочие коды, сбои) | blocked (заглушка) | skipped (не HTML)
function classify(result) {
  const sc = result.statusCode;
  if (sc === 404 || sc === 410) return 'gone';
  if (sc != null && sc >= 400) return 'error';
  if (result.skipped || !result.html) return 'skipped';
  if (looksLikeBlockPage(result.html)) return 'blocked';
  return 'ok';
}

// Видимый текст областью слежения, разбитый на блоки по границам блочных тегов. Подходит и для вёрстки на
// <div> (конструкторы вроде Tilda), где почти нет <p>/<li>, в отличие от прежнего селектора по тегам.
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head', 'canvas', 'select', 'option', 'textarea']);
const BLOCK_TAGS = new Set(('address article aside blockquote body dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 ' +
  'header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul br button label').split(' '));
const MAX_CHUNKS_STORED = 800;

function extractBlocks($, $scope) {
  const out = [];
  let buf = '';
  const flush = () => {
    const t = buf.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push(t);
    buf = '';
  };
  const walk = (node) => {
    if (node.type === 'text') { buf += node.data; return; }
    if (node.type !== 'tag') return;
    const name = (node.name || '').toLowerCase();
    if (SKIP_TAGS.has(name)) return;
    const block = BLOCK_TAGS.has(name);
    if (block) flush();
    (node.children || []).forEach(walk);
    if (block) flush();
  };
  $scope.each((i, el) => walk(el));
  flush();
  return out;
}

// Разбор загруженной страницы: заголовок, ссылки для обхода, картинки, текстовые блоки, hash.
// Всё, что зависит от настроек монитора, собрано здесь, чтобы первую и подтверждающую загрузку считать одинаково.
function analyzeHtml(html, url, cfg, log) {
  const watchSelector = (cfg.watchSelector || '').trim();
  const ignoreSelectors = (cfg.ignoreSelectors || '').split(',').map((x) => x.trim()).filter(Boolean);
  const markupMode = cfg.hashMode === 'markup';
  let title = null;
  let links = [];
  let imgUrls = [];
  let blocks = [];
  let scopeLinks = [];
  let scopedHtml = html;
  try {
    const $ = cheerio.load(html);
    title = ($('title').first().text() || '').trim().slice(0, 200) || null;
    // Ссылки и картинки собираем ДО удаления игнорируемых блоков: исключив шумный блок, нельзя рвать связи графа.
    if (cfg.trackImages) imgUrls = extractImages($, $('body').length ? $('body') : $.root(), url);
    links = extractLinksCheerio($, url);
    let $scope = $('body').length ? $('body') : $.root();
    if (watchSelector) {
      const matched = $(watchSelector);
      if (matched.length) $scope = matched.first();
      else if (log) log(`⚠️ CSS-селектор "${watchSelector}" не найден на ${url} — слежу за всей страницей целиком в этот раз`);
    }
    ignoreSelectors.forEach((sel) => {
      try { $scope.find(sel).remove(); } catch (e) { if (log) log(`⚠️ некорректный игнорируемый селектор "${sel}": ${e.message}`); }
    });
    scopedHtml = $.html($scope);
    blocks = extractBlocks($, $scope);
    const hs = new Set();
    $scope.find('a[href]').each((i, el) => {
      const n = normalizeUrl($(el).attr('href') || '', url);
      if (n && !SKIP_EXT.test(n)) hs.add(n);
    });
    scopeLinks = [...hs].sort();
  } catch (e) {
    if (log) log(`⚠️ не удалось разобрать HTML через cheerio на ${url} (${e.message}) — считаю без учёта CSS-селектора`);
    title = extractTitle(html);
    links = extractLinks(html, url);
    blocks = stripVolatile(html).replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    scopeLinks = [...links].sort();
  }
  const stripped = stripVolatile(scopedHtml);
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  // Заголовок и адреса ссылок входят в отпечаток: смена заголовка или адреса кнопки "Купить билет" — реальное изменение.
  const chunks = [...(title ? [`Заголовок: ${title}`] : []), ...blocks, ...scopeLinks.map((l) => `→ ${l}`)];
  const fpText = chunks.join('\n');
  return {
    title, links, imgUrls, chunks, stripped, normalized,
    rawLines: htmlToLines(stripped),
    hash: hashContent(markupMode ? normalized : fpText),
    length: markupMode ? normalized.length : fpText.length,
    hashVer: markupMode ? HASH_VERSION_MARKUP : HASH_VERSION_TEXT,
  };
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
const activeCrawls = new Set();

async function runCrawl(monitor) {
  // Два обхода одного монитора одновременно (по расписанию и вручную) читают одну и ту же базу и портят друг
  // другу сравнение: второй не запускаем.
  if (activeCrawls.has(monitor.id)) return { ok: false, busy: true, error: 'Обход этого монитора уже идёт' };
  activeCrawls.add(monitor.id);
  try {
    return await runCrawlLocked(monitor);
  } finally {
    activeCrawls.delete(monitor.id);
  }
}

async function runCrawlLocked(monitor) {
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
  const removeAfter = Number.isInteger(cfg.removeAfterMisses) && cfg.removeAfterMisses >= 1 ? cfg.removeAfterMisses : DEFAULT_REMOVE_AFTER;
  const fetcher = useBrowser ? (u) => fetchPageBrowser(browser, u) : fetchPage;

  const existingPages = await getCrawlPages(monitor.id);
  const prevByUrl = new Map(existingPages.map((p) => [p.url, p]));

  const visited = new Set();
  const queue = [{ url: startUrl, parent: null, depth: 0 }];
  const runTs = Date.now();

  const changes = { new: [], changed: [], removed: [], errors: 0, imagesChanged: 0, imagesNew: 0, rebaselined: 0, unstable: 0, deferred: 0 };
  let truncated = false;

  // Обработка одной страницы. Правило, ради которого всё переписано: сбой загрузки НИКОГДА не меняет то, что
  // известно о странице (hash, текст), и сам по себе не означает ни "изменилась", ни "исчезла".
  // Возвращает { ok, links } — ok=false, если страницу не удалось получить как обычный HTML.
  async function processUrl(item) {
    const { url, parent, depth, orphan } = item;
    setCrawlProgress(monitor.id, { running: true, currentUrl: url, visited: visited.size, queued: queue.length });
    const prev = prevByUrl.get(url);

    let result;
    try {
      result = await fetchRetry(fetcher, url, log);
    } catch (e) {
      await touchCrawlPageError(monitor.id, url, parent, depth, null, e.message);
      log(`❌ ошибка загрузки ${url} после ${FETCH_ATTEMPTS} попыток — ${e.message} (сохранённое состояние страницы не тронуто)`);
      changes.errors++;
      return { ok: false, links: [] };
    }

    const kind = classify(result);
    if (kind === 'gone') {
      // 404/410: настоящая "исчезла" только если так отвечают несколько обходов подряд. Один раз бывает из-за
      // сбоя CMS/кэша/деплоя.
      if (prev && prev.status !== 'removed') {
        const misses = (prev.missed_runs || 0) + 1;
        if (misses >= removeAfter) {
          await markCrawlPageRemoved(monitor.id, url, runTs, `Страница отвечает HTTP ${result.statusCode} уже ${misses} обхода подряд`);
          changes.removed.push(url);
          log(`🗑 ${url}: HTTP ${result.statusCode} ${misses} обхода подряд — считаю удалённой`);
        } else {
          await setCrawlPageMissed(monitor.id, url, misses, result.statusCode, `HTTP ${result.statusCode}: жду подтверждения удаления (${misses} из ${removeAfter})`);
          changes.deferred++;
          log(`⏳ ${url}: HTTP ${result.statusCode}, подтверждение удаления ${misses} из ${removeAfter} — пока не считаю удалённой`);
        }
      } else if (!prev) {
        await touchCrawlPageError(monitor.id, url, parent, depth, result.statusCode, `HTTP ${result.statusCode}`);
        log(`⚠️ ${url}: HTTP ${result.statusCode} (битая ссылка на сайте)`);
      }
      return { ok: false, links: [] };
    }
    if (kind !== 'ok') {
      const why = kind === 'blocked' ? 'пришла заглушка антибот-защиты/"доступ запрещён", а не страница сайта'
        : kind === 'skipped' ? `не HTML (content-type ${result.contentType || '—'}, код ${result.statusCode})`
          : `HTTP ${result.statusCode}`;
      await touchCrawlPageError(monitor.id, url, parent, depth, result.statusCode, kind === 'skipped' ? `Пропущено: ${why}` : why);
      log(`${kind === 'skipped' ? '⚠️' : '❌'} ${url}: ${why} (сохранённое состояние страницы не тронуто)`);
      if (kind !== 'skipped') changes.errors++;
      return { ok: false, links: [] };
    }

    const a = analyzeHtml(result.html, url, cfg, log);
    const prevChunks = prev && prev.items_json ? safeParseJsonArray(prev.items_json) : null;
    const prevRawLines = prev && prev.raw_lines_json ? safeParseJsonArray(prev.raw_lines_json) : null;
    const save = (status, error) => upsertCrawlPage(monitor.id, url, parent, depth, a.title, result.statusCode, a.hash, a.length, status, error || null,
      JSON.stringify(a.chunks.slice(0, MAX_CHUNKS_STORED)), a.normalized.slice(0, HASH_SNAPSHOT_LIMIT), JSON.stringify(a.rawLines), a.hashVer);
    const movedNote = (() => {
      try {
        const f = new URL(result.finalUrl || url), u0 = new URL(url);
        const strip = (p) => p.replace(/\/+$/, '').toLowerCase();
        return strip(f.pathname) !== strip(u0.pathname) || f.hostname !== u0.hostname ? ` (адрес перенаправляет на ${f.href})` : '';
      } catch (e) { return ''; }
    })();

    let status;
    if (!prev) {
      status = 'new';
      changes.new.push(url);
      await save('new');
      await insertCrawlChange(monitor.id, url, runTs, 'new', null, a.hash, `Новая страница обнаружена: ${a.title || url}${movedNote}`);
    } else if (prev.status === 'removed') {
      status = 'new';
      changes.new.push(url);
      await save('new');
      await insertCrawlChange(monitor.id, url, runTs, 'new', prev.content_hash, a.hash, `Страница снова доступна: ${a.title || url}`);
    } else if (!prev.content_hash || prev.hash_ver !== a.hashVer || (!prevChunks && prev.content_hash !== a.hash)) {
      // Нет надёжной базы для сравнения (строка пострадала от старого сбоя, сменился способ подсчёта hash):
      // запоминаем текущее состояние как эталон, не объявляя это изменением.
      status = 'unchanged';
      changes.rebaselined++;
      await save('unchanged');
    } else if (prev.content_hash === a.hash) {
      status = 'unchanged';
      await touchCrawlPage(monitor.id, url, result.statusCode, null);
    } else {
      status = await judgeChange(prev, a, result, url, parent, depth, prevChunks, prevRawLines, movedNote, save);
    }
    setCrawlProgress(monitor.id, { lastPageUrl: url, lastPageStatus: status, lastPageTs: Date.now() });

    // Картинки проверяем независимо от того, поменялся ли текст страницы — афишу могли заменить, ничего не
    // тронув в остальной вёрстке.
    if (cfg.trackImages && a.imgUrls.length) {
      // Если для этой страницы раньше не отслеживалось ни одной картинки, это установка базовой линии, а не
      // поток "новых картинок" (иначе включение галочки на большом сайте даёт лавину уведомлений).
      const existingImgs = await getCrawlImagesForPage(monitor.id, url);
      const hasBaseline = existingImgs.length > 0;
      let imgChanged = 0, imgNew = 0;
      for (const imgUrl of a.imgUrls) {
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

    return { ok: true, links: a.links, htmlLength: result.html.length, statusCode: result.statusCode, server: result.server, setCookie: result.setCookie, finalUrl: result.finalUrl, html: result.html };
  }

  // hash отличается от сохранённого. Прежде чем объявить "изменилась", проверяем, что это не шум.
  async function judgeChange(prev, a, result, url, parent, depth, prevChunks, prevRawLines, movedNote, save) {
    // 1) Подтверждающая загрузка: реальное изменение стабильно, сбой/шум — нет.
    await sleep(CONFIRM_DELAY_MS);
    let a2 = null;
    try {
      const r2 = await fetchRetry((u) => (useBrowser ? fetchPageBrowser(browser, u) : fetchPage(u)), url, log, 2);
      if (classify(r2) === 'ok') a2 = analyzeHtml(r2.html, url, cfg, log);
    } catch (e) { /* ниже: не удалось подтвердить */ }
    if (!a2) {
      await touchCrawlPage(monitor.id, url, result.statusCode, 'Изменение не удалось подтвердить повторной загрузкой, проверю в следующий обход');
      changes.deferred++;
      log(`⏳ ${url}: содержимое отличается, но повторная загрузка не удалась — решу в следующий обход`);
      return 'unchanged';
    }
    // 2) Если две загрузки подряд отличаются друг от друга, на странице есть самоменяющиеся блоки (случайные
    // карточки, "N минут назад", счётчики). Их исключаем из сравнения, остальное сравниваем как обычно.
    const volatile = new Set();
    if (a2.hash !== a.hash) {
      const s1 = new Set(a.chunks), s2 = new Set(a2.chunks);
      for (const t of s1) if (!s2.has(t)) volatile.add(t);
      for (const t of s2) if (!s1.has(t)) volatile.add(t);
      changes.unstable++;
      log(`〰️ ${url}: две загрузки подряд различаются в ${volatile.size} блоках — считаю их самоменяющимися и не учитываю`);
    }
    const sizeDelta = a.length - (prev.content_length || 0);
    let added = [], removed = [];
    if (prevChunks) {
      const ops = lcsDiff(prevChunks, a.chunks);
      added = ops.filter((o) => o.type === 'add' && !volatile.has(o.text)).map((o) => o.text);
      removed = ops.filter((o) => o.type === 'remove' && !volatile.has(o.text)).map((o) => o.text);
    }
    const markupMode = cfg.hashMode === 'markup';
    if (prevChunks && !added.length && !removed.length && (volatile.size || !markupMode)) {
      await touchCrawlPage(monitor.id, url, result.statusCode, volatile.size ? 'Различия только в самоменяющихся блоках — не считаю изменением' : null);
      return 'unchanged';
    }
    // 3) Резкое сокращение страницы (ошибка на стороне сайта, обрезанный ответ) принимаем, только если оно
    // повторится в следующем обходе.
    const prevLen = prev.content_length || 0;
    if (prevLen > 2000 && a.length < prevLen * 0.35 && prev.pending_hash !== a.hash) {
      await setCrawlPagePending(monitor.id, url, a.hash, `Страница резко сократилась (${a.length} из ${prevLen} симв.), жду подтверждения в следующем обходе`);
      changes.deferred++;
      log(`⏳ ${url}: страница сократилась с ${prevLen} до ${a.length} симв. — приму, если так будет и в следующем обходе`);
      return 'unchanged';
    }
    // 4) Это настоящее изменение.
    let summary;
    if (prevChunks) {
      summary = summarizeChunkDiff(added, removed, sizeDelta);
      if (!added.length && !removed.length && prev.hash_snapshot) {
        const diff = findFirstDiff(prev.hash_snapshot, a.normalized);
        if (diff) summary += ` · место расхождения в разметке: было "…${diff.oldCtx}…" стало "…${diff.newCtx}…"`;
      }
    } else {
      summary = `Контент изменился (размер ${sizeDelta >= 0 ? '+' : ''}${sizeDelta} симв.)`;
    }
    let diffJson = null;
    if (prevRawLines) {
      const lineOps = lcsDiff(prevRawLines, a.rawLines);
      if (lineOps.some((o) => o.type !== 'equal')) diffJson = JSON.stringify(buildHunks(lineOps));
    }
    changes.changed.push(url);
    await save('changed');
    await insertCrawlChange(monitor.id, url, runTs, 'changed', prev.content_hash, a.hash, summary + movedNote, diffJson);
    return 'changed';
  }

  let startFailed = false;
  while (queue.length) {
    if (visited.size >= maxPages) {
      truncated = queue.length > 0;
      break;
    }
    const item = queue.shift();
    if (visited.has(item.url)) continue;
    visited.add(item.url);
    const r = await processUrl(item);
    if (item.depth === 0 && !r.ok) { startFailed = true; break; }
    if (item.depth < maxDepth && r.ok) {
      let addedToQueue = 0;
      let trapsSkipped = 0;
      for (const link of r.links) {
        if (visited.has(link)) continue;
        if (sameHostOnly && new URL(link).hostname !== startHost) continue;
        if (looksLikeCrawlerTrap(link)) { trapsSkipped++; continue; }
        queue.push({ url: link, parent: item.url, depth: item.depth + 1 });
        addedToQueue++;
      }
      log(`${item.url} (глубина ${item.depth}) → статус ${r.statusCode}, html ${r.htmlLength} симв., ссылок найдено ${r.links.length}, добавлено в очередь ${addedToQueue}${trapsSkipped ? `, пропущено как вероятная URL-ловушка ${trapsSkipped}` : ''}`);
      // Ссылок аномально мало для полученного объёма HTML — вероятно, анти-бот заглушка/JS-челлендж хостинга.
      if (r.links.length === 0 && r.htmlLength < 5000) {
        const snippet = r.html.replace(/\s+/g, ' ').trim().slice(0, 400);
        log(`⚠️ подозрительно короткий ответ без ссылок — сервер: "${r.server || '—'}", итоговый URL: ${r.finalUrl}${r.setCookie ? ', выставил Set-Cookie (похоже на антибот-челлендж)' : ''}`);
        log(`⚠️ вот что реально пришло: "${snippet}${r.htmlLength > 400 ? '…' : ''}"`);
      }
    }
  }

  if (startFailed) {
    // Не открылась сама стартовая страница: это сбой сайта или сети, а не изменение сайта. Ничего не трогаем.
    log('❌ стартовая страница не открылась — обход прерван, состояние всех страниц сохранено без изменений');
    await setCrawlState(monitor.id, runTs, 'error', visited.size, false, debugLog);
    return { ok: false, error: 'Стартовая страница не открылась', debugLog };
  }

  // Страницы, до которых в этот раз не дошли по ссылкам (ссылка пропала из меню, глубина, сбой родителя), НЕ
  // считаются удалёнными. Открываем каждую напрямую: живая страница обрабатывается как обычно, удалённой её
  // сделают только повторные 404/410. Если упёрлись в лимит страниц, до этих страниц просто не дошли.
  let orphansChecked = 0;
  if (!truncated) {
    const orphans = existingPages
      .filter((p) => !visited.has(p.url) && p.status !== 'removed')
      .sort((x, y) => (x.last_checked_ts || 0) - (y.last_checked_ts || 0))
      .slice(0, MAX_ORPHAN_CHECKS);
    for (const p of orphans) {
      await processUrl({ url: p.url, parent: p.parent_url, depth: p.depth, orphan: true });
      orphansChecked++;
    }
    if (orphansChecked) log(`Страниц без ссылок в этот обход проверено напрямую: ${orphansChecked}`);
  }

  log(`Готово: страниц просмотрено ${visited.size}, новых ${changes.new.length}, изменилось ${changes.changed.length}, исчезло ${changes.removed.length}, ошибок ${changes.errors}, картинок изменилось ${changes.imagesChanged}, новых картинок ${changes.imagesNew}` +
    `${changes.rebaselined ? `, переучено без события ${changes.rebaselined}` : ''}${changes.deferred ? `, ждут подтверждения ${changes.deferred}` : ''}${changes.unstable ? `, нестабильных ${changes.unstable}` : ''}${truncated ? ' (упёрлись в лимит страниц)' : ''}`);

  await setCrawlState(monitor.id, runTs, 'ok', visited.size, truncated, debugLog);

  const removed = changes.removed;
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
