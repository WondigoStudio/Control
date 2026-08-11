const grid = document.getElementById('grid');
const globalDot = document.getElementById('globalDot');
const summaryText = document.getElementById('summaryText');
const clockEl = document.getElementById('clock');
const sortBtn = document.getElementById('sortBtn');

const detail = document.getElementById('detail');
const detailTitle = document.getElementById('detailTitle');
const detailMeta = document.getElementById('detailMeta');
const detailChart = document.getElementById('detailChart');
const detailLog = document.getElementById('detailLog');
const detailStats = document.getElementById('detailStats');
const detailIncidents = document.getElementById('detailIncidents');
const periodSwitch = document.getElementById('periodSwitch');

document.getElementById('detailClose').onclick = () => (detail.hidden = true);
detail.addEventListener('click', (e) => { if (e.target === detail) detail.hidden = true; });

let sortByReliability = false;
let currentMonitor = null;
let currentHours = 24;

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
          <div class="card__target">${escapeHtml(m.target)}</div>
        </div>
        <span class="badge ${m.status}">${statusLabel(m.status)}</span>
      </div>
      ${m.ssl ? sslBadgeHtml(m.ssl) : ''}
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
      ${m.status === 'down' && m.lastError ? `<div class="card__error">${escapeHtml(m.lastError)}</div>` : ''}
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
}

async function loadDetail(m) {
  detailMeta.innerHTML = `
    <span>статус: ${statusLabel(m.status)}</span>
    <span>последняя проверка: ${fmtTime(m.lastCheckedAt)}</span>
  `;

  const days = Math.max(1, Math.round(currentHours / 24));

  const [historyRes, statsRes, incidentsRes, heatmapRes] = await Promise.all([
    fetch(`/api/monitors/${m.id}/history?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/stats?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/incidents?days=${days}`),
    fetch(`/api/monitors/${m.id}/heatmap?days=90`),
  ]);

  const history = await historyRes.json();
  const stats = await statsRes.json();
  const incidents = await incidentsRes.json();
  const heatmap = await heatmapRes.json();

  renderStats(stats);
  drawChart(history);
  renderLog(history);
  renderIncidents(incidents);
  renderHeatmap(heatmap);
  renderSSL(m.ssl);
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
    <div class="incident ${inc.ongoing ? 'ongoing' : ''}">
      <span>${fmtTime(inc.start)}</span>
      <span class="err">${escapeHtml(inc.error || 'ошибка')}</span>
      <span class="dur">${fmtDuration(inc.durationMs)}</span>
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
  const recent = history.slice(-30).reverse();
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

function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString('ru-RU');
}

setInterval(tickClock, 1000);
tickClock();

loadMonitors();
setInterval(loadMonitors, 15000);
