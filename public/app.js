const grid = document.getElementById('grid');
const globalDot = document.getElementById('globalDot');
const summaryText = document.getElementById('summaryText');
const clockEl = document.getElementById('clock');
const sortBtn = document.getElementById('sortBtn');

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
}

// --- Управление мониторами (Этап 9) ---

const monitorFormModal = document.getElementById('monitorFormModal');
const monitorForm = document.getElementById('monitorForm');
const monitorFormTitle = document.getElementById('monitorFormTitle');
const formError = document.getElementById('formError');
const deleteMonitorBtn = document.getElementById('deleteMonitorBtn');
let editingMonitorId = null; // null = создаём новый

document.getElementById('addMonitorBtn').addEventListener('click', () => openMonitorForm(null));
document.getElementById('monitorFormClose').addEventListener('click', closeMonitorForm);
monitorFormModal.addEventListener('click', (e) => { if (e.target === monitorFormModal) closeMonitorForm(); });

document.getElementById('f_type').addEventListener('change', updateFormFieldsVisibility);
document.getElementById('f_recoveryProvider').addEventListener('change', updateFormFieldsVisibility);

function updateFormFieldsVisibility() {
  const type = document.getElementById('f_type').value;
  document.getElementById('row_url').hidden = type !== 'http';
  document.getElementById('row_botToken').hidden = type !== 'telegram_bot';
  document.getElementById('row_expectedStatus').hidden = type !== 'http';
  document.getElementById('row_expectedContent').hidden = type !== 'http';
  document.getElementById('row_expectedContentAbsent').hidden = type !== 'http';

  const provider = document.getElementById('f_recoveryProvider').value;
  document.getElementById('recoveryFields').hidden = provider === 'none';
}

async function openMonitorForm(monitor) {
  formError.textContent = '';
  editingMonitorId = monitor ? monitor.id : null;
  monitorFormTitle.textContent = monitor ? `Редактировать: ${monitor.name}` : 'Новый монитор';
  deleteMonitorBtn.hidden = !monitor;

  document.getElementById('f_id').value = monitor ? monitor.id : '';
  document.getElementById('f_id').disabled = !!monitor; // id менять нельзя после создания
  document.getElementById('f_name').value = monitor ? monitor.name : '';
  document.getElementById('f_type').value = monitor ? monitor.type : 'http';
  document.getElementById('f_url').value = monitor && monitor.url ? monitor.url : '';
  document.getElementById('f_botToken').value = monitor && monitor.botToken ? monitor.botToken : '';
  document.getElementById('f_intervalSec').value = monitor && monitor.intervalSec ? monitor.intervalSec : 60;
  document.getElementById('f_timeoutMs').value = monitor && monitor.timeoutMs ? monitor.timeoutMs : 8000;
  document.getElementById('f_expectedStatus').value = monitor && monitor.expectedStatus ? monitor.expectedStatus : 200;
  document.getElementById('f_expectedContent').value = monitor && monitor.expectedContent ? monitor.expectedContent : '';
  document.getElementById('f_expectedContentAbsent').value = monitor && monitor.expectedContentAbsent
    ? (Array.isArray(monitor.expectedContentAbsent) ? monitor.expectedContentAbsent.join(', ') : monitor.expectedContentAbsent)
    : '';
  document.getElementById('f_hosting').value = monitor && monitor.hosting ? monitor.hosting : 'other';

  const recovery = monitor && monitor.recovery ? monitor.recovery : (monitor && monitor.deployHookUrl ? { provider: 'render', deployHookUrl: monitor.deployHookUrl, afterFails: monitor.restartAfterFails } : null);
  document.getElementById('f_recoveryProvider').value = recovery ? recovery.provider : 'none';
  document.getElementById('f_deployHookUrl').value = recovery && recovery.deployHookUrl ? recovery.deployHookUrl : '';
  document.getElementById('f_afterFails').value = recovery && recovery.afterFails ? recovery.afterFails : 3;
  document.getElementById('f_maxAttempts').value = recovery && recovery.maxAttempts ? recovery.maxAttempts : 2;
  document.getElementById('f_maxPerHour').value = recovery && recovery.maxPerHour ? recovery.maxPerHour : 5;

  document.getElementById('f_backupUrl').value = monitor && monitor.failover && monitor.failover.backupUrl ? monitor.failover.backupUrl : '';

  const flapping = monitor && monitor.flapping ? monitor.flapping : null;
  document.getElementById('f_flappingEnabled').checked = !flapping || flapping.enabled !== false;
  document.getElementById('f_flappingWindow').value = flapping && flapping.windowMinutes ? flapping.windowMinutes : 10;
  document.getElementById('f_flappingThreshold').value = flapping && flapping.threshold ? flapping.threshold : 3;

  updateFormFieldsVisibility();
  monitorFormModal.hidden = false;
}

function closeMonitorForm() {
  monitorFormModal.hidden = true;
}

function buildMonitorPayload() {
  const type = document.getElementById('f_type').value;
  const payload = {
    id: document.getElementById('f_id').value.trim(),
    name: document.getElementById('f_name').value.trim(),
    type,
    intervalSec: parseInt(document.getElementById('f_intervalSec').value, 10) || 60,
    timeoutMs: parseInt(document.getElementById('f_timeoutMs').value, 10) || 8000,
    hosting: document.getElementById('f_hosting').value,
  };

  if (type === 'http') {
    payload.url = document.getElementById('f_url').value.trim();
    payload.expectedStatus = parseInt(document.getElementById('f_expectedStatus').value, 10) || 200;
    const expectedContent = document.getElementById('f_expectedContent').value.trim();
    if (expectedContent) payload.expectedContent = expectedContent;
    const expectedContentAbsent = document.getElementById('f_expectedContentAbsent').value.trim();
    if (expectedContentAbsent) {
      payload.expectedContentAbsent = expectedContentAbsent.split(',').map((s) => s.trim()).filter(Boolean);
    }
  } else {
    payload.botToken = document.getElementById('f_botToken').value.trim();
  }

  const recoveryProvider = document.getElementById('f_recoveryProvider').value;
  if (recoveryProvider !== 'none') {
    payload.recovery = {
      provider: recoveryProvider,
      enabled: true,
      deployHookUrl: document.getElementById('f_deployHookUrl').value.trim(),
      afterFails: parseInt(document.getElementById('f_afterFails').value, 10) || 3,
      maxAttempts: parseInt(document.getElementById('f_maxAttempts').value, 10) || 2,
      retryAfterFails: 10,
      maxPerHour: parseInt(document.getElementById('f_maxPerHour').value, 10) || 5,
    };
  } else {
    payload.recovery = { provider: 'none' };
  }

  const backupUrl = document.getElementById('f_backupUrl').value.trim();
  if (backupUrl) {
    payload.failover = { backupUrl };
  }

  payload.flapping = {
    enabled: document.getElementById('f_flappingEnabled').checked,
    windowMinutes: parseInt(document.getElementById('f_flappingWindow').value, 10) || 10,
    threshold: parseInt(document.getElementById('f_flappingThreshold').value, 10) || 3,
  };

  return payload;
}

monitorForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  const payload = buildMonitorPayload();

  try {
    const res = await fetch(
      editingMonitorId ? `/api/config/monitors/${editingMonitorId}` : '/api/config/monitors',
      {
        method: editingMonitorId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      formError.textContent = data.error || 'Не удалось сохранить';
      return;
    }
    closeMonitorForm();
    loadMonitors();
  } catch (err) {
    formError.textContent = 'Ошибка соединения: ' + err.message;
  }
});

deleteMonitorBtn.addEventListener('click', async () => {
  if (!editingMonitorId) return;
  if (!confirm(`Удалить монитор "${document.getElementById('f_name').value}"? Это действие необратимо.`)) return;

  try {
    const res = await fetch(`/api/config/monitors/${editingMonitorId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      formError.textContent = data.error || 'Не удалось удалить';
      return;
    }
    closeMonitorForm();
    closeDetail();
    loadMonitors();
  } catch (err) {
    formError.textContent = 'Ошибка соединения: ' + err.message;
  }
});

document.getElementById('checkNowBtn').addEventListener('click', async () => {
  if (!currentMonitor) return;
  const btn = document.getElementById('checkNowBtn');
  const resultBox = document.getElementById('checkNowResult');

  btn.disabled = true;
  btn.textContent = '⏳ Проверяю...';
  resultBox.hidden = true;

  try {
    const res = await fetch(`/api/monitors/${currentMonitor.id}/check-now`, { method: 'POST' });
    const result = await res.json();
    renderCheckNowResult(result, currentMonitor);
  } catch (e) {
    resultBox.hidden = false;
    resultBox.innerHTML = `<div class="empty" style="color:var(--down);">Ошибка: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Проверить сейчас (подробно)';
  }
});

function checkRow(label, valueText, ok, warn) {
  const icon = ok === null ? '—' : (warn ? '⚠' : (ok ? '✓' : '✗'));
  const cls = ok === null ? 'cn-neutral' : (warn ? 'cn-warn' : (ok ? 'cn-ok' : 'cn-fail'));
  return `<div class="cn-row"><span class="cn-label">${escapeHtml(label)}</span><span class="cn-value">${escapeHtml(valueText)}</span><span class="cn-icon ${cls}">${icon}</span></div>`;
}

function renderCheckNowResult(result, monitor) {
  const resultBox = document.getElementById('checkNowResult');
  resultBox.hidden = false;

  let rows = '';

  if (result.timing) {
    const t = result.timing;
    const dns = t.dns ?? 0;
    const tcp = t.tcp !== null && t.tcp !== undefined ? Math.max(t.tcp - dns, 0) : null;
    const tls = t.tls !== null && t.tls !== undefined ? Math.max(t.tls - (t.tcp ?? dns), 0) : null;
    const server = t.ttfb !== null && t.ttfb !== undefined ? Math.max(t.ttfb - (t.tls ?? t.tcp ?? dns), 0) : null;
    const download = t.total !== null && t.total !== undefined ? Math.max(t.total - (t.ttfb ?? 0), 0) : null;

    if (t.dns !== null) rows += checkRow('DNS', `${dns} мс`, dns < 500, dns >= 200 && dns < 500);
    if (tcp !== null) rows += checkRow('TCP', `${tcp} мс`, tcp < 500, tcp >= 300 && tcp < 500);
    if (tls !== null) rows += checkRow('TLS', `${tls} мс`, tls < 800, tls >= 500 && tls < 800);
    if (server !== null) rows += checkRow('Сервер (TTFB)', `${server} мс`, server < 1500, server >= 1000 && server < 1500);
    if (download !== null) rows += checkRow('Загрузка', `${download} мс`, download < 800, download >= 500 && download < 800);
  }

  rows += '<div class="cn-divider"></div>';
  rows += checkRow('HTTP-статус', result.statusCode !== null ? String(result.statusCode) : '—', result.statusCode !== null ? (result.statusCode < 400) : null);
  rows += checkRow('Контент', result.contentOk === null ? 'не проверялось' : (result.contentOk ? 'совпадает' : 'не совпадает'), result.contentOk);

  if (monitor.ssl) {
    rows += checkRow('SSL-сертификат', monitor.ssl.daysLeft !== null && monitor.ssl.daysLeft !== undefined ? `ещё ${monitor.ssl.daysLeft} дн.` : (monitor.ssl.error || '—'), monitor.ssl.valid, monitor.ssl.valid && monitor.ssl.daysLeft <= 14);
  }

  const diagOk = result.ok;
  const diagLabel = diagOk ? 'HEALTHY' : (result.error || 'ОШИБКА');
  const diagCategory = diagOk ? null : null; // категория недоступна напрямую из check-now, используем текст ошибки

  resultBox.innerHTML = `
    <div class="cn-rows">${rows}</div>
    <div class="cn-diagnosis ${diagOk ? 'cn-diag-ok' : 'cn-diag-fail'}">
      Diagnosis: <b>${escapeHtml(diagLabel)}</b>
    </div>
  `;
}

document.getElementById('maintenanceBtn').addEventListener('click', async () => {
  if (!currentMonitor) return;

  const isOn = currentMonitor.maintenance && currentMonitor.maintenance.enabled;
  if (isOn) {
    await fetch(`/api/monitors/${currentMonitor.id}/maintenance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    loadDetail(currentMonitor);
    loadMonitors();
    return;
  }

  const minutesStr = prompt('На сколько минут включить режим обслуживания?\n(оставь пустым — до ручного выключения)', '30');
  if (minutesStr === null) return; // отмена

  const minutes = minutesStr.trim() ? parseInt(minutesStr, 10) : null;
  await fetch(`/api/monitors/${currentMonitor.id}/maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, minutes }),
  });
  loadDetail(currentMonitor);
  loadMonitors();
});

document.getElementById('editMonitorBtn').addEventListener('click', async () => {
  if (!currentMonitor) return;
  const monitorId = currentMonitor.id;
  closeDetail();
  const res = await fetch('/api/config/monitors');
  const configs = await res.json();
  const fullConfig = configs.find((c) => c.id === monitorId);
  if (fullConfig) openMonitorForm(fullConfig);
});

const detail = document.getElementById('detail');
const detailTitle = document.getElementById('detailTitle');
const detailMeta = document.getElementById('detailMeta');
const detailChart = document.getElementById('detailChart');
const detailLog = document.getElementById('detailLog');
const detailStats = document.getElementById('detailStats');
const detailIncidents = document.getElementById('detailIncidents');
const periodSwitch = document.getElementById('periodSwitch');

let sortByReliability = false;
let currentMonitor = null;
let currentHours = 24;
let detailRefreshTimer = null;

document.getElementById('detailClose').onclick = () => closeDetail();
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });

function closeDetail() {
  detail.hidden = true;
  currentMonitor = null;
  if (detailRefreshTimer) {
    clearInterval(detailRefreshTimer);
    detailRefreshTimer = null;
  }
}

sortBtn.onclick = () => {
  sortByReliability = !sortByReliability;
  sortBtn.classList.toggle('active', sortByReliability);
  loadMonitors();
};

periodSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !currentMonitor) return;
  [...periodSwitch.children].forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  currentHours = parseInt(btn.dataset.hours, 10);
  chartZoomRange = null; // новый период — старый зум по времени больше не актуален
  loadDetail(currentMonitor);
});

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU');
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  return `${ms} мс`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `${h} ч ${m} мин`;
  const d = Math.floor(h / 24);
  return `${d} д ${h % 24} ч`;
}

function statusLabel(s) {
  if (s === 'up') return 'работает';
  if (s === 'down') return 'недоступен';
  return 'нет данных';
}

// Кэш последнего списка мониторов из общего 15-секундного опроса
// (loadMonitors ниже). detailRefreshTimer переиспользует эти данные вместо
// собственного отдельного fetch('/api/monitors') — раньше при открытой
// детальной карточке список мониторов запрашивался ДВАЖДЫ каждые 15 сек
// двумя независимыми таймерами без всякой на то причины.
let latestMonitorsData = [];

async function loadMonitors() {
  const url = sortByReliability ? '/api/monitors?sort=reliability' : '/api/monitors';
  const res = await fetch(url);
  const data = await res.json();
  latestMonitorsData = data;
  renderGrid(data);
  updateSummary(data);
  loadSummaryBar();
}

async function loadSummaryBar() {
  const res = await fetch('/api/summary');
  const data = await res.json();
  renderSummaryBar(data);
}

function renderSummaryBar(data) {
  const box = document.getElementById('summaryBar');
  if (!data.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <div class="summary-title">Сводка за 7 дней · от наименее надёжного</div>
    <table class="summary-table">
      <thead>
        <tr><th>Объект</th><th>Аптайм 7д</th><th>Ср. отклик</th><th>Инцидентов</th></tr>
      </thead>
      <tbody>
        ${data.map((m) => `
          <tr>
            <td>${escapeHtml(m.name)}</td>
            <td class="${m.uptime7d !== null && m.uptime7d < 99 ? 'sum-warn' : 'sum-ok'}">${m.uptime7d ?? '—'}%</td>
            <td>${fmtMs(m.avgResponseMs)}</td>
            <td>${m.incidentsCount}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function updateSummary(data) {
  const down = data.filter((m) => m.status === 'down').length;
  const total = data.length;
  if (down === 0) {
    globalDot.style.background = 'var(--up)';
    summaryText.textContent = `все системы в норме · ${total} объект(ов)`;
  } else {
    globalDot.style.background = 'var(--down)';
    summaryText.textContent = `${down} из ${total} недоступны`;
  }
}

function hostingLabel(hosting) {
  const labels = {
    render: 'Render',
    infinityfree: 'InfinityFree',
    vps: 'VPS',
    hidden_cloud: 'Hidden Cloud',
  };
  return labels[hosting] || null;
}

function categoryIcon(category) {
  const icons = {
    DNS_PROBLEM: '🌐',
    SSL_PROBLEM: '🔒',
    CONNECTION_REFUSED: '🚫',
    TIMEOUT: '⏱️',
    HTTP_ERROR: '⚠️',
    CONTENT_MISMATCH: '📄',
    HOSTING_PROBLEM: '🖥️',
    SUSPENDED: '💳',
    NETWORK_PROBLEM: '📡',
    UNKNOWN: '❓',
  };
  return icons[category] || '⚠️';
}

function sslBadgeHtml(ssl) {
  if (ssl.error && !ssl.valid) return '';
  if (ssl.daysLeft === null || ssl.daysLeft === undefined) return '';
  if (ssl.daysLeft <= 14) {
    return `<div class="ssl-mini warn">🔒 SSL истекает через ${ssl.daysLeft} дн.</div>`;
  }
  return '';
}

function renderGrid(data) {
  grid.innerHTML = '';
  data.forEach((m) => {
    const card = document.createElement('div');
    card.className = `card ${m.status}`;
    card.onclick = () => openDetail(m);

    card.innerHTML = `
      <div class="card__top">
        <div>
          <div class="card__name">${escapeHtml(m.name)}</div>
          <div class="card__target">${escapeHtml(m.target)}${hostingLabel(m.hosting) ? ` · <span class="host-badge">${escapeHtml(hostingLabel(m.hosting))}</span>` : ''}</div>
        </div>
        <span class="badge ${m.status}">${statusLabel(m.status)}</span>
      </div>
      ${m.ssl ? sslBadgeHtml(m.ssl) : ''}
      ${m.hasAutoRestart ? '<div class="ssl-mini" style="color:var(--up);">🔁 автоперезапуск настроен</div>' : ''}
      ${m.maintenance && m.maintenance.enabled ? '<div class="ssl-mini" style="color:var(--accent);">🔧 на обслуживании</div>' : ''}
      <div class="card__stats">
        <div>
          <div class="stat__value">${fmtMs(m.lastResponseMs)}</div>
          <div class="stat__label">отклик</div>
        </div>
        <div>
          <div class="stat__value">${m.uptime24h ?? '—'}%</div>
          <div class="stat__label">аптайм 24ч</div>
        </div>
        <div>
          <div class="stat__value">${m.uptime7d ?? '—'}%</div>
          <div class="stat__label">аптайм 7д</div>
        </div>
      </div>
      ${m.status === 'down' && m.lastErrorDiagnosis ? `
        <div class="card__error">
          <div class="diag-label">${categoryIcon(m.lastErrorDiagnosis.category)} ${escapeHtml(m.lastErrorDiagnosis.label)}</div>
          <div class="diag-explain">${escapeHtml(m.lastErrorDiagnosis.explanation)}</div>
        </div>
      ` : (m.status === 'down' && m.lastError ? `<div class="card__error">${escapeHtml(m.lastError)}</div>` : '')}
    `;
    grid.appendChild(card);
  });
}

async function openDetail(m) {
  currentMonitor = m;
  currentHours = 24;
  chartZoomRange = null; // открываем другой монитор — зум от предыдущего графика неприменим
  [...periodSwitch.children].forEach((b) => b.classList.toggle('active', b.dataset.hours === '24'));
  detail.hidden = false;
  detailTitle.textContent = m.name;
  document.getElementById('checkNowResult').hidden = true;
  await loadDetail(m);

  if (detailRefreshTimer) clearInterval(detailRefreshTimer);
  detailRefreshTimer = setInterval(async () => {
    if (!currentMonitor || detail.hidden) return;
    // Берём свежие данные из общего опроса дашборда (latestMonitorsData,
    // обновляется тем же интервалом loadMonitors) вместо отдельного
    // fetch('/api/monitors') — тот же результат, но без дублирующего запроса.
    const fresh = latestMonitorsData.find((x) => x.id === currentMonitor.id);
    if (fresh) {
      currentMonitor = fresh;
      await loadDetail(fresh);
    }
  }, 15000);
}

async function loadDetail(m) {
  detailMeta.innerHTML = `
    <span>статус: ${statusLabel(m.status)}</span>
    <span>последняя проверка: ${fmtTime(m.lastCheckedAt)}</span>
  `;

  const maintenanceBtn = document.getElementById('maintenanceBtn');
  const isInMaintenance = m.maintenance && m.maintenance.enabled;
  maintenanceBtn.textContent = isInMaintenance ? '🔧 выключить обслуживание' : '🔧 обслуживание';
  maintenanceBtn.classList.toggle('active', !!isInMaintenance);

  const days = Math.max(1, Math.round(currentHours / 24));

  const [historyRes, statsRes, incidentsRes, heatmapRes, restartsRes] = await Promise.all([
    fetch(`/api/monitors/${m.id}/history?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/stats?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/incidents?days=${days}`),
    fetch(`/api/monitors/${m.id}/heatmap?days=90`),
    fetch(`/api/monitors/${m.id}/restarts`),
  ]);

  const history = await historyRes.json();
  const stats = await statsRes.json();
  const incidents = await incidentsRes.json();
  const heatmap = await heatmapRes.json();
  const restarts = await restartsRes.json();

  renderStats(stats);
  renderChart(history);
  renderLog(history);
  renderIncidents(incidents);
  renderHeatmap(heatmap);
  renderSSL(m.ssl);
  renderTiming(history);
  renderRestarts(restarts);
  renderBotHealth(history);

  const cachedLocations = await fetch(`/api/monitors/${m.id}/locations`).then((r) => r.json());
  renderLocations(cachedLocations);
}

function renderBotHealth(history) {
  const box = document.getElementById('botHealthBox');
  const withHealth = [...history].reverse().find((h) => h.bot_health);
  if (!withHealth) {
    box.hidden = true;
    return;
  }
  let health;
  try {
    health = JSON.parse(withHealth.bot_health);
  } catch (e) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const uptimeStr = health.uptimeSec !== null ? fmtDuration(health.uptimeSec * 1000) : '—';
  box.innerHTML = `🤖 Health-эндпоинт бота: процесс жив, аптайм процесса ${uptimeStr}${health.version ? `, версия ${escapeHtml(health.version)}` : ''}`;
}

function renderLocations(data) {
  const box = document.getElementById('locationsResults');
  if (!data || !data.results) {
    box.innerHTML = '<div class="empty" style="font-family:var(--mono);font-size:12px;color:var(--text-dim);margin-top:8px;">Ещё не проверялось — нажми кнопку выше</div>';
    return;
  }
  const ageMin = Math.round((Date.now() - data.ts) / 60000);
  box.innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin:8px 0;">Последняя проверка: ${ageMin < 1 ? 'только что' : ageMin + ' мин назад'}</div>
    <div class="loc-grid">
      ${data.results.map((r) => `
        <div class="loc-cell ${r.ok === true ? 'loc-ok' : r.ok === false ? 'loc-down' : 'loc-unknown'}">
          <div class="loc-label">${escapeHtml(r.label)}</div>
          <div class="loc-status">${r.ok === true ? `✓ ${r.responseMs} мс` : r.ok === false ? `✗ ${escapeHtml(r.error || 'недоступен')}` : '— нет данных'}</div>
        </div>
      `).join('')}
    </div>
  `;
}

document.getElementById('checkLocationsBtn').addEventListener('click', async () => {
  if (!currentMonitor) return;
  const btn = document.getElementById('checkLocationsBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Проверяю из 6 стран...';
  try {
    const res = await fetch(`/api/monitors/${currentMonitor.id}/locations`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      document.getElementById('locationsResults').innerHTML = `<div class="empty" style="color:var(--down);">${escapeHtml(data.error)}</div>`;
    } else {
      renderLocations(data);
    }
  } catch (e) {
    document.getElementById('locationsResults').innerHTML = `<div class="empty" style="color:var(--down);">Ошибка: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🌍 Проверить сейчас';
  }
});

function renderRestarts(restarts) {
  const section = document.getElementById('restartsSection');
  const box = document.getElementById('detailRestarts');
  if (!restarts.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  box.innerHTML = restarts.map((r) => `
    <div class="incident">
      <span>${fmtTime(r.ts)}</span>
      <span class="err">${r.success ? '✓ запрос отправлен успешно' : '✗ ' + escapeHtml(r.error || 'ошибка')}</span>
    </div>
  `).join('');
}

function renderTiming(history) {
  const box = document.getElementById('timingBox');
  const withTiming = [...history].reverse().find((h) => h.timing_breakdown);
  if (!withTiming) {
    box.hidden = true;
    return;
  }
  let t;
  try {
    t = JSON.parse(withTiming.timing_breakdown);
  } catch (e) {
    box.hidden = true;
    return;
  }

  const dns = t.dns ?? 0;
  const tcp = t.tcp !== null && t.tcp !== undefined ? Math.max(t.tcp - dns, 0) : 0;
  const tls = t.tls !== null && t.tls !== undefined ? Math.max(t.tls - (t.tcp ?? dns), 0) : 0;
  const serverStage = t.ttfb !== null && t.ttfb !== undefined ? Math.max(t.ttfb - (t.tls ?? t.tcp ?? dns), 0) : 0;
  const download = t.total !== null && t.total !== undefined ? Math.max(t.total - (t.ttfb ?? 0), 0) : 0;
  const total = t.total || (dns + tcp + tls + serverStage + download) || 1;

  const segments = [
    { label: 'DNS', ms: dns, cls: 'seg-dns' },
    { label: 'TCP', ms: tcp, cls: 'seg-tcp' },
    { label: 'TLS', ms: tls, cls: 'seg-tls' },
    { label: 'Сервер', ms: serverStage, cls: 'seg-server' },
    { label: 'Загрузка', ms: download, cls: 'seg-download' },
  ];

  box.hidden = false;
  box.innerHTML = `
    <div class="timing-title">Разбивка времени ответа (последний замер)</div>
    <div class="timing-bar">
      ${segments.map((s) => s.ms > 0 ? `<div class="timing-seg ${s.cls}" style="width:${Math.max((s.ms / total) * 100, 2)}%" title="${s.label}: ${s.ms} мс"></div>` : '').join('')}
    </div>
    <div class="timing-legend">
      ${segments.map((s) => `<span class="timing-item"><i class="${s.cls}"></i>${s.label}: ${s.ms} мс</span>`).join('')}
    </div>
  `;
}

function renderSSL(ssl) {
  const box = document.getElementById('sslBox');
  if (!ssl || (ssl.daysLeft === null && !ssl.error)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (ssl.error && !ssl.valid) {
    box.className = 'ssl-box danger';
    box.innerHTML = `🔒 SSL-сертификат: ошибка проверки — ${escapeHtml(ssl.error)}`;
    return;
  }
  const warn = ssl.daysLeft <= 14;
  box.className = 'ssl-box' + (warn ? ' warn' : ' ok');
  box.innerHTML = warn
    ? `🔒 SSL-сертификат истекает через <b>${ssl.daysLeft} дн.</b> — пора продлить`
    : `🔒 SSL-сертификат действителен ещё ${ssl.daysLeft} дн.`;
}

function renderHeatmap(days) {
  const box = document.getElementById('heatmap');
  if (!days.length) {
    box.innerHTML = '<div class="empty" style="font-family:var(--mono);font-size:12px;color:var(--text-dim);">Пока нет данных</div>';
    return;
  }
  const map = {};
  days.forEach((d) => { map[d.day] = d.uptime; });

  const cells = [];
  const today = new Date();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const uptime = map[key];
    let cls = 'hm-empty';
    if (uptime !== undefined) {
      if (uptime >= 99.9) cls = 'hm-100';
      else if (uptime >= 95) cls = 'hm-95';
      else if (uptime >= 80) cls = 'hm-80';
      else cls = 'hm-low';
    }
    cells.push(`<div class="hm-cell ${cls}" title="${key}: ${uptime !== undefined ? uptime + '%' : 'нет данных'}"></div>`);
  }
  box.innerHTML = cells.join('');
}

function renderStats(stats) {
  detailStats.innerHTML = `
    <div class="stat-box"><div class="v">${fmtMs(stats.avg)}</div><div class="l">среднее</div></div>
    <div class="stat-box"><div class="v">${fmtMs(stats.min)}</div><div class="l">минимум</div></div>
    <div class="stat-box"><div class="v">${fmtMs(stats.max)}</div><div class="l">максимум</div></div>
  `;
}

function renderIncidents(incidents) {
  if (!incidents.length) {
    detailIncidents.innerHTML = '<div class="empty">Падений не зафиксировано за этот период</div>';
    return;
  }
  detailIncidents.innerHTML = incidents.map((inc) => {
    const statusLabel = inc.ongoing ? 'ONGOING' : 'RECOVERED';
    const statusClass = inc.ongoing ? 'inc-status-ongoing' : 'inc-status-recovered';

    let recoveryResultLabel = '—';
    let recoveryResultClass = '';
    if (inc.recovery && inc.recovery.attempted) {
      if (inc.recovery.result === 'success') { recoveryResultLabel = 'SUCCESS'; recoveryResultClass = 'inc-result-success'; }
      else if (inc.recovery.result === 'not_implemented') { recoveryResultLabel = 'NOT IMPLEMENTED'; recoveryResultClass = 'inc-result-warn'; }
      else { recoveryResultLabel = 'FAILED'; recoveryResultClass = 'inc-result-fail'; }
    }

    const recoveryProviderLabel = inc.recovery && inc.recovery.attempted
      ? (inc.recovery.provider === 'render' ? 'Render Deploy Hook' : (inc.recovery.provider || '—'))
      : 'не запускалось';

    return `
    <div class="incident-card ${inc.ongoing ? 'ongoing' : ''}">
      <div class="inc-header">
        <span class="inc-id">Incident #${inc.id}</span>
        <span class="inc-status ${statusClass}">${statusLabel}</span>
      </div>

      <div class="inc-grid">
        <div class="inc-field"><span class="inc-label">Started</span><span class="inc-value">${fmtTime(inc.start)}</span></div>
        <div class="inc-field"><span class="inc-label">Duration</span><span class="inc-value">${fmtDuration(inc.durationMs)}</span></div>

        <div class="inc-field"><span class="inc-label">Cause</span><span class="inc-value">${inc.diagnosis ? categoryIcon(inc.diagnosis.category) + ' ' + inc.diagnosis.category : 'UNKNOWN'}</span></div>
        <div class="inc-field"><span class="inc-label">Checks failed</span><span class="inc-value">${inc.checksFailed}</span></div>

        <div class="inc-field inc-field-wide"><span class="inc-label">Diagnosis</span><span class="inc-value">${inc.diagnosis ? escapeHtml(inc.diagnosis.label) : '—'}</span></div>

        <div class="inc-field"><span class="inc-label">Recovery</span><span class="inc-value">${escapeHtml(recoveryProviderLabel)}</span></div>
        <div class="inc-field"><span class="inc-label">Result</span><span class="inc-value ${recoveryResultClass}">${recoveryResultLabel}</span></div>

        <div class="inc-field inc-field-wide"><span class="inc-label">Notification</span><span class="inc-value">${inc.notificationSent ? '📧 Email sent' : '— not sent'}</span></div>
      </div>

      ${inc.diagnosis ? `
        <div class="incident-diag">
          <div class="diag-explain">${escapeHtml(inc.diagnosis.explanation)}</div>
          <div class="diag-suggest">💡 ${escapeHtml(inc.diagnosis.suggestion)}</div>
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

// --- Zoom графика ---
// Запоминаем полную (не увеличенную) историю за выбранный период, чтобы
// можно было выделить отрезок мышью и приблизить его, а потом сбросить
// обратно к полному виду без повторного запроса к серверу.
//
// Зум хранится как ВРЕМЕННОЙ диапазон (ts), а не индексы массива — history
// каждые 15с перезапрашивается заново и переиндексируется, а по timestamp
// один и тот же участок графика находится заново после обновления данных,
// поэтому увеличенный отрезок не прыгает обратно к полному виду сам собой.
let chartFullHistory = [];
let chartMouseUpHandler = null; // чтобы не плодить обработчики на window при каждой перерисовке
let chartZoomRange = null; // { from: ts, to: ts } | null — null означает "показываем всё"

function renderChart(history) {
  chartFullHistory = history;

  if (chartZoomRange) {
    const zoomed = history.filter((h) => h.ts >= chartZoomRange.from && h.ts <= chartZoomRange.to);
    // Если после обновления данных в диапазоне почти ничего не осталось
    // (например, переключили период и старый зум больше не имеет смысла) —
    // тихо сбрасываем зум вместо показа пустого/бессмысленного графика.
    if (zoomed.length >= 2) {
      document.getElementById('resetZoomBtn').hidden = false;
      drawChart(zoomed);
      return;
    }
    chartZoomRange = null;
  }

  document.getElementById('resetZoomBtn').hidden = true;
  drawChart(history);
}

function zoomChartToRange(startIdx, endIdx) {
  const from = Math.max(0, Math.min(startIdx, endIdx));
  const to = Math.min(chartFullHistory.length - 1, Math.max(startIdx, endIdx));
  if (to - from < 1) return; // слишком маленькое выделение — не увеличиваем
  chartZoomRange = { from: chartFullHistory[from].ts, to: chartFullHistory[to].ts };
  document.getElementById('resetZoomBtn').hidden = false;
  drawChart(chartFullHistory.slice(from, to + 1));
}

document.getElementById('resetZoomBtn').addEventListener('click', () => {
  chartZoomRange = null;
  document.getElementById('resetZoomBtn').hidden = true;
  drawChart(chartFullHistory);
});

function drawChart(history) {
  detailChart.innerHTML = '';
  if (!history.length) {
    detailChart.innerHTML = '<text x="10" y="80" fill="#767d82" font-size="12">Пока нет данных</text>';
    return;
  }

  const w = 640, h = 160;
  const padLeft = 46, padRight = 10, padTop = 10, padBottom = 24;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const values = history.map((hh) => hh.response_ms || 0);
  const max = Math.max(...values, 1);
  const niceMax = Math.ceil(max / 100) * 100 || 100;

  const stepX = plotW / Math.max(history.length - 1, 1);
  const svgNS = 'http://www.w3.org/2000/svg';

  // Горизонтальная сетка + подписи по оси Y (мс)
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((niceMax / ySteps) * i);
    const y = padTop + plotH - (val / niceMax) * plotH;

    const gridLine = document.createElementNS(svgNS, 'line');
    gridLine.setAttribute('x1', padLeft);
    gridLine.setAttribute('x2', w - padRight);
    gridLine.setAttribute('y1', y);
    gridLine.setAttribute('y2', y);
    gridLine.setAttribute('stroke', '#22262b');
    gridLine.setAttribute('stroke-width', '1');
    detailChart.appendChild(gridLine);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', padLeft - 8);
    label.setAttribute('y', y + 3);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', '#767d82');
    label.setAttribute('font-family', 'JetBrains Mono, monospace');
    label.textContent = val;
    detailChart.appendChild(label);
  }

  // Подписи по оси X (время) — 6 равномерно распределённых точек вместо 3,
  // чтобы легче было понять, в какой именно момент произошёл всплеск/провал
  const xLabelCount = Math.min(6, history.length);
  const xLabelIndices = [];
  for (let i = 0; i < xLabelCount; i++) {
    xLabelIndices.push(Math.round((i / (xLabelCount - 1 || 1)) * (history.length - 1)));
  }
  [...new Set(xLabelIndices)].forEach((idx) => {
    const item = history[idx];
    const x = padLeft + idx * stepX;
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', h - 6);
    label.setAttribute('text-anchor', idx === 0 ? 'start' : idx === history.length - 1 ? 'end' : 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', '#767d82');
    label.setAttribute('font-family', 'JetBrains Mono, monospace');
    label.textContent = fmtChartTime(item.ts);
    detailChart.appendChild(label);

    // Тонкая вертикальная засечка под каждой подписью — легче сопоставить
    // подпись времени с точным местом на линии графика
    const tick = document.createElementNS(svgNS, 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('x2', x);
    tick.setAttribute('y1', padTop + plotH);
    tick.setAttribute('y2', padTop + plotH + 4);
    tick.setAttribute('stroke', '#3a4046');
    tick.setAttribute('stroke-width', '1');
    detailChart.appendChild(tick);
  });

  // Линия графика
  const pathPoints = history.map((hItem, i) => {
    const x = padLeft + i * stepX;
    const y = padTop + plotH - ((hItem.response_ms || 0) / niceMax) * plotH;
    return `${x},${y}`;
  });

  const line = document.createElementNS(svgNS, 'polyline');
  line.setAttribute('points', pathPoints.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#35c48c');
  line.setAttribute('stroke-width', '1.5');
  detailChart.appendChild(line);

  // Красные точки на моментах падения
  history.forEach((hItem, i) => {
    if (!hItem.ok) {
      const x = padLeft + i * stepX;
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', padTop + plotH);
      dot.setAttribute('r', 3);
      dot.setAttribute('fill', '#e35b52');
      detailChart.appendChild(dot);
    }
  });

  // Подпись оси Y целиком
  const axisLabel = document.createElementNS(svgNS, 'text');
  axisLabel.setAttribute('x', 4);
  axisLabel.setAttribute('y', 12);
  axisLabel.setAttribute('font-size', '9');
  axisLabel.setAttribute('fill', '#767d82');
  axisLabel.setAttribute('font-family', 'JetBrains Mono, monospace');
  axisLabel.textContent = 'мс';
  detailChart.appendChild(axisLabel);

  // --- Интерактивная подсказка при наведении ---
  // Вертикальная линия-курсор + текст с точным временем и значением в этой точке,
  // чтобы было понятно, что именно произошло в конкретный момент графика.
  const hoverLine = document.createElementNS(svgNS, 'line');
  hoverLine.setAttribute('y1', padTop);
  hoverLine.setAttribute('y2', padTop + plotH);
  hoverLine.setAttribute('stroke', '#767d82');
  hoverLine.setAttribute('stroke-width', '1');
  hoverLine.setAttribute('stroke-dasharray', '3,3');
  hoverLine.style.display = 'none';
  detailChart.appendChild(hoverLine);

  const hoverDot = document.createElementNS(svgNS, 'circle');
  hoverDot.setAttribute('r', 3.5);
  hoverDot.setAttribute('fill', '#f2b544');
  hoverDot.style.display = 'none';
  detailChart.appendChild(hoverDot);

  const hoverBg = document.createElementNS(svgNS, 'rect');
  hoverBg.setAttribute('height', 28);
  hoverBg.setAttribute('rx', 4);
  hoverBg.setAttribute('fill', '#131619');
  hoverBg.setAttribute('stroke', '#22262b');
  hoverBg.style.display = 'none';
  detailChart.appendChild(hoverBg);

  const hoverText = document.createElementNS(svgNS, 'text');
  hoverText.setAttribute('font-size', '9');
  hoverText.setAttribute('fill', '#d7dbdd');
  hoverText.setAttribute('font-family', 'JetBrains Mono, monospace');
  hoverText.style.display = 'none';
  detailChart.appendChild(hoverText);

  const overlay = document.createElementNS(svgNS, 'rect');
  overlay.setAttribute('x', padLeft);
  overlay.setAttribute('y', padTop);
  overlay.setAttribute('width', plotW);
  overlay.setAttribute('height', plotH);
  overlay.setAttribute('fill', 'transparent');
  overlay.style.cursor = 'crosshair';
  detailChart.appendChild(overlay);

  // --- Выделение отрезка мышью для увеличения (zoom) ---
  const selectionRect = document.createElementNS(svgNS, 'rect');
  selectionRect.setAttribute('y', padTop);
  selectionRect.setAttribute('height', plotH);
  selectionRect.setAttribute('fill', 'rgba(242, 181, 68, 0.15)');
  selectionRect.setAttribute('stroke', '#f2b544');
  selectionRect.setAttribute('stroke-width', '1');
  selectionRect.style.display = 'none';
  detailChart.appendChild(selectionRect);

  let dragStartIdx = null;
  let isDragging = false;

  function xToIndex(clientX) {
    const rect = detailChart.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * w;
    return Math.max(0, Math.min(history.length - 1, Math.round((svgX - padLeft) / stepX)));
  }

  overlay.addEventListener('mousedown', (evt) => {
    isDragging = true;
    dragStartIdx = xToIndex(evt.clientX);
  });

  if (chartMouseUpHandler) window.removeEventListener('mouseup', chartMouseUpHandler);
  chartMouseUpHandler = (evt) => {
    if (!isDragging) return;
    isDragging = false;
    selectionRect.style.display = 'none';
    if (dragStartIdx === null) return;
    const endIdx = xToIndex(evt.clientX);
    if (Math.abs(endIdx - dragStartIdx) >= 2) {
      zoomChartToRange(dragStartIdx, endIdx);
    }
    dragStartIdx = null;
  };
  window.addEventListener('mouseup', chartMouseUpHandler);

  overlay.addEventListener('mousemove', (evt) => {
    const rect = detailChart.getBoundingClientRect();
    const svgX = ((evt.clientX - rect.left) / rect.width) * w;
    const idx = Math.max(0, Math.min(history.length - 1, Math.round((svgX - padLeft) / stepX)));
    const item = history[idx];
    if (!item) return;

    // Если тащим мышью с зажатой кнопкой — рисуем прямоугольник выделения
    if (isDragging && dragStartIdx !== null) {
      const startX = padLeft + dragStartIdx * stepX;
      const currentX = padLeft + idx * stepX;
      selectionRect.setAttribute('x', Math.min(startX, currentX));
      selectionRect.setAttribute('width', Math.abs(currentX - startX));
      selectionRect.style.display = '';
    }

    const x = padLeft + idx * stepX;
    const y = padTop + plotH - ((item.response_ms || 0) / niceMax) * plotH;

    hoverLine.setAttribute('x1', x);
    hoverLine.setAttribute('x2', x);
    hoverLine.style.display = '';

    hoverDot.setAttribute('cx', x);
    hoverDot.setAttribute('cy', y);
    hoverDot.style.display = '';

    const timeStr = new Date(item.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const valueStr = item.ok === 0 ? 'недоступен' : `${item.response_ms ?? '—'} мс`;
    const text = `${timeStr} · ${valueStr}`;
    hoverText.textContent = text;

    const textWidth = text.length * 5.2 + 12;
    let boxX = x + 8;
    if (boxX + textWidth > w - padRight) boxX = x - textWidth - 8;

    hoverBg.setAttribute('x', boxX);
    hoverBg.setAttribute('y', padTop + 4);
    hoverBg.setAttribute('width', textWidth);
    hoverBg.style.display = '';

    hoverText.setAttribute('x', boxX + 6);
    hoverText.setAttribute('y', padTop + 21);
    hoverText.style.display = '';
  });

  overlay.addEventListener('mouseleave', () => {
    hoverLine.style.display = 'none';
    hoverDot.style.display = 'none';
    hoverBg.style.display = 'none';
    hoverText.style.display = 'none';
  });
}

function fmtChartTime(ts) {
  const d = new Date(ts);
  if (currentHours <= 24) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function renderLog(history) {
  const recent = history.slice(-200).reverse();
  detailLog.innerHTML = recent.map((h) => {
    let headersLine = '';
    if (h.response_headers) {
      try {
        const hdrs = JSON.parse(h.response_headers);
        const parts = [];
        if (hdrs.server) parts.push(`сервер: ${hdrs.server}`);
        if (hdrs['content-type']) parts.push(`тип: ${hdrs['content-type'].split(';')[0]}`);
        if (hdrs['content-length']) parts.push(`размер: ${hdrs['content-length']} байт`);
        if (parts.length) headersLine = `<div class="log-headers">${escapeHtml(parts.join(' · '))}</div>`;
      } catch (e) {}
    }
    const sizeAnomalyLine = h.size_anomaly
      ? `<div class="log-headers" style="color:var(--accent);">⚠️ необычный размер ответа: ${h.response_size} байт (сильно отличается от обычного)</div>`
      : '';
    return `
    <div class="${h.ok ? 'ok' : 'fail'}">
      <span>${fmtTime(h.ts)}</span>
      <span>${h.ok ? '✓ OK' : '✗ ' + (h.error || 'ошибка')}</span>
      <span>${fmtMs(h.response_ms)}</span>
    </div>
    ${headersLine}
    ${sizeAnomalyLine}
  `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Часы в шапке считаются от времени СЕРВЕРА (Render), а не от локальных
// часов устройства — так они не зависят от того, правильно ли настроено
// время на компьютере/телефоне пользователя.
let serverTimeOffset = 0; // разница между временем сервера и временем устройства, мс

async function syncServerTime() {
  try {
    const t0 = Date.now();
    const res = await fetch('/api/time');
    const data = await res.json();
    const t1 = Date.now();
    const roundTrip = t1 - t0;
    // Компенсируем время сетевого запроса — предполагаем, что половина
    // задержки ушла на путь туда, половина — обратно
    const estimatedServerNow = data.now + roundTrip / 2;
    serverTimeOffset = estimatedServerNow - t1;
  } catch (e) {
    // Если не удалось получить время сервера — остаёмся на локальных часах устройства
  }
}

function tickClock() {
  const correctedNow = new Date(Date.now() + serverTimeOffset);
  clockEl.textContent = correctedNow.toLocaleTimeString('ru-RU');
}

syncServerTime().then(tickClock);
setInterval(tickClock, 1000);
setInterval(syncServerTime, 60000); // пересинхронизация раз в минуту, чтобы не накапливался дрейф

// Браузер замедляет таймеры в неактивных вкладках — при возврате
// фокуса на страницу сразу пересинхронизируем часы и данные,
// чтобы не показывать устаревшее время.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncServerTime().then(tickClock);
    loadMonitors();
    if (currentMonitor && !detail.hidden) {
      loadDetail(currentMonitor);
    }
  }
});

loadMonitors();
setInterval(loadMonitors, 15000);
