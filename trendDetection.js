// Predictive Failure Detection: ищем устойчивый рост времени ответа ДО того,
// как монитор реально упадёт. Это не про "стало 500ms вместо 480ms" (шум),
// а про "было ~180ms, стало ~980ms за 4 часа, и рост монотонный".
//
// Намеренно НЕ триггерим на уже упавших мониторах — там уже работает
// Incident lifecycle из checker.js, это отдельная, более ранняя сигнализация.

const { getHourlyResponseBuckets, getTrendState, upsertTrendState, clearTrendState } = require('./db');
const { notify, formatNotifyTimeShort } = require('./notifier');

const DEFAULTS = {
  windowHours: 4,          // за сколько часов смотрим тренд
  minBuckets: 4,           // минимум часовых точек с данными, иначе рано судить
  minBaselineMs: 20,       // если baseline меньше — процентные скачки это шум, а не сигнал
  ratioThreshold: 2,       // во сколько раз должно вырасти, чтобы считать деградацией
  monotonicRatio: 0.7,     // доля "не уменьшающихся" переходов между соседними точками
  cooldownMinutes: 180,    // не спамить повторно, пока тренд продолжается на том же уровне
  resetRatio: 1.3,         // если ratio упал ниже этого — считаем, что деградация прошла
};

function resolveConfig(monitor) {
  const cfg = monitor.trendDetection || {};
  return { ...DEFAULTS, ...cfg, enabled: cfg.enabled !== false };
}

// Считает, монотонно ли растёт последовательность (допускает небольшие
// просадки — реальные сети шумят, требуем ТЕНДЕНЦИЮ, а не идеальную прямую).
function monotonicityScore(values) {
  if (values.length < 2) return 0;
  let nonDecreasing = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) nonDecreasing++;
  }
  return nonDecreasing / (values.length - 1);
}

async function checkTrend(monitor, currentStatus) {
  if (monitor.type !== 'http') return; // телеграм-боты замеряются иначе, не сопоставимо
  if (currentStatus !== 'up') return; // уже down — этим занимается incident lifecycle

  const config = resolveConfig(monitor);
  if (!config.enabled) return;

  const sinceTs = Date.now() - config.windowHours * 60 * 60 * 1000;
  const buckets = await getHourlyResponseBuckets(monitor.id, sinceTs);

  if (buckets.length < config.minBuckets) return; // недостаточно данных, рано судить

  const values = buckets.map((b) => b.avgMs);
  const baseline = values[0];
  const latest = values[values.length - 1];

  if (baseline < config.minBaselineMs) return; // слишком быстрый монитор, % роста не показателен

  const ratio = latest / baseline;
  const monotonic = monotonicityScore(values);

  const prevState = await getTrendState(monitor.id);

  if (ratio < config.resetRatio) {
    // Деградация прошла (или её не было) — сбрасываем состояние, чтобы
    // следующий цикл деградации снова уведомил сразу, а не ждал cooldown
    // от старого, уже неактуального тренда.
    if (prevState) await clearTrendState(monitor.id);
    return;
  }

  const isDegrading = ratio >= config.ratioThreshold && monotonic >= config.monotonicRatio;
  if (!isDegrading) return;

  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const lastNotified = prevState ? prevState.last_notified_ts : 0;
  if (prevState && Date.now() - lastNotified < cooldownMs) return; // уже предупреждали недавно про этот же тренд

  await upsertTrendState(monitor.id, Date.now(), baseline, ratio);

  const trendLines = buckets
    .map((b) => `${formatNotifyTimeShort(b.ts)}  ${b.avgMs}ms`)
    .join('\n');

  await notify(
    `⚠️ Ухудшение производительности: ${monitor.name}`,
    `Сервис "${monitor.name}" пока отвечает, но время ответа устойчиво растёт.\n\n` +
    `Задержка выросла ~${ratio.toFixed(1)}× за последние ${config.windowHours} ч.\n\n` +
    `${trendLines}\n\n` +
    `Падения ещё не произошло — это ранний сигнал, стоит проверить нагрузку/логи заранее.`
  );
}

module.exports = { checkTrend };
