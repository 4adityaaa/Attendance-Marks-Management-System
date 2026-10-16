// Shared helpers used by every page
const TOKEN_KEY = 'portal_token';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  location.href = '/';
}

async function api(url, options = {}) {
  const headers = { Authorization: 'Bearer ' + getToken(), ...(options.headers || {}) };
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(url, { ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Session ended'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function photoUrl(file) { return file ? '/uploads/' + encodeURIComponent(file) : ''; }

function percent(att, total) { return total ? Math.round((att / total) * 100) : 0; }
function attClass(p) { return p >= 80 ? 'good' : p >= 60 ? 'warn' : 'bad'; }
function barColor(p) { return p >= 80 ? 'var(--good)' : p >= 60 ? 'var(--warn)' : 'var(--bad)'; }

function renderBarChart(elementId, items, valueLabel = '%') {
  const element = document.getElementById(elementId);
  if (!items.length) {
    element.innerHTML = '<p class="chart-empty">No data available yet.</p>';
    return;
  }
  element.innerHTML = items.map(({ label, value, color }) => {
    const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
    const display = value === null ? '—' : `${Math.round(safeValue)}${valueLabel}`;
    return `<div class="chart-row" title="${esc(label)}: ${display}">
      <span class="chart-label">${esc(label)}</span>
      <span class="chart-track"><i class="chart-fill" style="width:${safeValue}%;${color ? `background:${color}` : ''}"></i></span>
      <span class="chart-value">${display}</span>
    </div>`;
  }).join('');
}

function renderDonut(chartId, legendId, segments, accessibleLabel) {
  const chart = document.getElementById(chartId);
  const legend = document.getElementById(legendId);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  let offset = 0;
  const stops = segments.map((segment) => {
    const start = offset;
    offset += total ? segment.value / total * 100 : 0;
    return `${segment.color} ${start}% ${offset}%`;
  });
  chart.style.background = total
    ? `conic-gradient(${stops.join(', ')})`
    : 'conic-gradient(#f1e6e6 0 100%)';
  chart.setAttribute('aria-label', accessibleLabel);
  legend.innerHTML = segments.map((segment) => `
    <li><i class="legend-dot" style="background:${segment.color}"></i>${esc(segment.label)} <b>${segment.value}</b></li>
  `).join('');
}
