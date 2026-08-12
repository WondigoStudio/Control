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

async function loadMonitors() {
  const url = sortByReliability ? '/api/monitors?sort=reliability' : '/api/monitors';
  const res = await fetch(url);
  const data = await res.json();
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
  [...periodSwitch.children].forEach((b) => b.classList.toggle('active', b.dataset.hours === '24'));
  detail.hidden = false;
  detailTitle.textContent = m.name;
  await loadDetail(m);

  if (detailRefreshTimer) clearInterval(detailRefreshTimer);
  detailRefreshTimer = setInterval(async () => {
    if (!currentMonitor || detail.hidden) return;
    // Подтягиваем свежий статус монитора, затем перезагружаем детали
    const res = await fetch('/api/monitors');
    const list = await res.json();
    const fresh = list.find((x) => x.id === currentMonitor.id);
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
  drawChart(history);
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
  detailIncidents.innerHTML = incidents.map((inc) => `
    <div class="incident-block ${inc.ongoing ? 'ongoing' : ''}">
      <div class="incident">
        <span>${fmtTime(inc.start)}</span>
        <span class="err">${inc.diagnosis ? categoryIcon(inc.diagnosis.category) + ' ' + escapeHtml(inc.diagnosis.label) : escapeHtml(inc.error || 'ошибка')}</span>
        <span class="dur">${fmtDuration(inc.durationMs)}</span>
      </div>
      ${inc.diagnosis ? `
        <div class="incident-diag">
          <div class="diag-explain">${escapeHtml(inc.diagnosis.explanation)}</div>
          <div class="diag-suggest">💡 ${escapeHtml(inc.diagnosis.suggestion)}</div>
          <div class="incident-meta">
            <span>Неудачных проверок: ${inc.checksFailed}</span>
            ${inc.recovery && inc.recovery.attempted ? `<span>· Восстановление (${escapeHtml(inc.recovery.provider || '?')}): ${inc.recovery.result === 'success' ? '✓ успешно' : '✗ не удалось'}</span>` : ''}
            ${inc.notificationSent ? '<span>· 📧 уведомление отправлено</span>' : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `).join('');
}

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

  // Подписи по оси X (время) — первая, средняя, последняя точка
  const xLabelIndices = [0, Math.floor((history.length - 1) / 2), history.length - 1];
  xLabelIndices.forEach((idx) => {
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
    return `
    <div class="${h.ok ? 'ok' : 'fail'}">
      <span>${fmtTime(h.ts)}</span>
      <span>${h.ok ? '✓ OK' : '✗ ' + (h.error || 'ошибка')}</span>
      <span>${fmtMs(h.response_ms)}</span>
    </div>
    ${headersLine}
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
