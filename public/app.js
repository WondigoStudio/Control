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

  const [historyRes, statsRes, incidentsRes] = await Promise.all([
    fetch(`/api/monitors/${m.id}/history?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/stats?hours=${currentHours}`),
    fetch(`/api/monitors/${m.id}/incidents?days=${days}`),
  ]);

  const history = await historyRes.json();
  const stats = await statsRes.json();
  const incidents = await incidentsRes.json();

  renderStats(stats);
  drawChart(history);
  renderLog(history);
  renderIncidents(incidents);
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
  const w = 640, h = 140, pad = 10;
  const values = history.map((h) => h.response_ms || 0);
  const max = Math.max(...values, 1);
  const stepX = (w - pad * 2) / Math.max(history.length - 1, 1);

  const svgNS = 'http://www.w3.org/2000/svg';

  const pathPoints = history.map((hItem, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (hItem.response_ms || 0) / max) * (h - pad * 2);
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
      const x = pad + i * stepX;
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', h - pad);
      dot.setAttribute('r', 3);
      dot.setAttribute('fill', '#e35b52');
      detailChart.appendChild(dot);
    }
  });
}

function renderLog(history) {
  const recent = history.slice(-30).reverse();
  detailLog.innerHTML = recent.map((h) => `
    <div class="${h.ok ? 'ok' : 'fail'}">
      <span>${fmtTime(h.ts)}</span>
      <span>${h.ok ? '✓ OK' : '✗ ' + (h.error || 'ошибка')}</span>
      <span>${fmtMs(h.response_ms)}</span>
    </div>
  `).join('');
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
