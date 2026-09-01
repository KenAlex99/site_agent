import { RendererRegistry } from './renderers/renderer-registry.js';
import { chartJsRenderer } from './renderers/chartjs-renderer.js';
import { uPlotRenderer } from './renderers/uplot-renderer.js';

const registry = new RendererRegistry().register(chartJsRenderer).register(uPlotRenderer);
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const state = { overview: null, devices: [], ports: [], alerts: [], selectedDevice: '', selectedPort: '', poller: null };

async function request(path) {
  const response = await fetch(path, { headers: { accept: 'application/json', 'x-request-id': crypto.randomUUID() } });
  let body = {};
  try { body = await response.json(); } catch { /* safe fallback */ }
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

async function refreshDashboard() {
  setBusy(true);
  hideGlobalError();
  const [health, overview, devices, alerts] = await Promise.allSettled([
    request('/api/v1/monitoring/health'), request('/api/v1/monitoring/overview'),
    request('/api/v1/monitoring/devices'), request('/api/v1/monitoring/alerts?limit=12')
  ]);
  renderProvider(health);
  if (overview.status === 'fulfilled') renderOverview(overview.value); else panelError('availability-chart', overview.reason.message);
  if (devices.status === 'fulfilled') await renderDevices(devices.value.items || []); else showGlobalError(devices.reason.message);
  if (alerts.status === 'fulfilled') renderAlerts(alerts.value.items || []); else panelError('severity-chart', alerts.reason.message);
  elements['updated-at'].textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  setBusy(false);
}

function renderProvider(result) {
  const health = result.status === 'fulfilled' ? result.value : { status: 'down' };
  elements['provider-name'].textContent = health.provider?.name || 'LibreNMS';
  elements['provider-state'].textContent = health.status === 'up' ? 'API 连接正常' : (health.message || '连接异常');
  elements['provider-dot'].className = health.status === 'up' ? 'online' : 'offline';
}

function renderOverview(overview) {
  state.overview = overview;
  setText('device-total', overview.devices.total);
  setText('device-up', overview.devices.up);
  setText('device-down', overview.devices.down);
  setText('alert-active', overview.alerts.active);
  setText('alert-critical', overview.alerts.severities.critical || 0);
  registry.render(elements['availability-chart'], {
    engine: 'chartjs', kind: 'doughnut', title: '设备可用性', labels: ['在线', '离线', '其他'],
    datasets: [{ name: '设备', values: [overview.devices.up, overview.devices.down, Math.max(0, overview.devices.total - overview.devices.up - overview.devices.down)], colors: ['#1dd3b0', '#fb7185', '#334155'] }]
  });
  const severities = overview.alerts.severities;
  registry.render(elements['severity-chart'], {
    engine: 'chartjs', kind: 'bar', title: '告警等级分布', legend: false,
    labels: ['严重', '警告', '信息', '未知'], datasets: [{ name: '告警', values: [severities.critical || 0, severities.warning || 0, severities.info || 0, severities.unknown || 0], colors: ['#fb7185', '#ffb703', '#60a5fa', '#64748b'] }]
  });
}

async function renderDevices(devices) {
  state.devices = devices;
  fillSelect(elements.devices, devices, (item) => item.id, (item) => `${item.name} · ${stateLabel(item.status)}`, '暂无设备');
  if (!devices.length) return;
  const previous = devices.some((item) => item.id === state.selectedDevice) ? state.selectedDevice : devices[0].id;
  state.selectedDevice = previous;
  elements.devices.value = previous;
  await loadPorts();
}

async function loadPorts() {
  stopPolling();
  elements.ports.disabled = true;
  elements.ports.replaceChildren(option('读取端口…', ''));
  try {
    const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(state.selectedDevice)}/ports`);
    state.ports = body.items || [];
    fillSelect(elements.ports, state.ports, (item) => item.id, (item) => `${item.name} · ${stateLabel(item.status)}`, '暂无端口');
    elements.ports.disabled = !state.ports.length;
    if (!state.ports.length) return clearTraffic('当前设备没有可展示端口');
    state.selectedPort = state.ports.some((item) => item.id === state.selectedPort) ? state.selectedPort : state.ports[0].id;
    elements.ports.value = state.selectedPort;
    renderSnapshot();
    await sampleTraffic();
    state.poller = setInterval(sampleTraffic, 10_000);
  } catch (error) { clearTraffic(error.message, true); }
}

function renderSnapshot() {
  const port = state.ports.find((item) => item.id === state.selectedPort);
  if (!port) return;
  setText('rx-value', formatBps(port.rxBps));
  setText('tx-value', formatBps(port.txBps));
  registry.render(elements['snapshot-chart'], {
    engine: 'chartjs', kind: 'bar', title: '端口速率快照', unit: 'bps', legend: false,
    labels: ['入方向', '出方向'], datasets: [{ name: port.name, values: [port.rxBps, port.txBps], colors: ['#1dd3b0', '#60a5fa'] }]
  });
}

async function sampleTraffic() {
  if (!state.selectedDevice || !state.selectedPort) return;
  try {
    const query = new URLSearchParams({ deviceId: state.selectedDevice, portId: state.selectedPort });
    const frame = await request(`/api/v1/monitoring/series/port-traffic?${query}`);
    const latestRx = frame.series[0]?.points.at(-1)?.[1];
    const latestTx = frame.series[1]?.points.at(-1)?.[1];
    setText('rx-value', formatBps(latestRx));
    setText('tx-value', formatBps(latestTx));
    registry.render(elements['traffic-chart'], { engine: 'uplot', kind: 'timeseries', title: frame.title, unit: frame.unit, series: frame.series });
  } catch (error) { panelError('traffic-chart', error.message); }
}

function renderAlerts(alerts) {
  state.alerts = alerts;
  setText('alert-count', alerts.length);
  elements['alert-list'].replaceChildren();
  if (!alerts.length) return elements['alert-list'].append(empty('暂无告警，运行态势平稳'));
  const fragment = document.createDocumentFragment();
  for (const alert of alerts) {
    const row = document.createElement('article');
    row.className = 'alert-row';
    const marker = document.createElement('i'); marker.className = `severity ${alert.severity}`;
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = alert.title;
    const meta = document.createElement('p'); meta.textContent = `${alert.deviceName || `设备 ${alert.deviceId}`} · ${timeLabel(alert.openedAt)}`;
    copy.append(title, meta);
    const badge = document.createElement('span'); badge.className = `severity-badge ${alert.severity}`; badge.textContent = severityLabel(alert.severity);
    row.append(marker, copy, badge); fragment.append(row);
  }
  elements['alert-list'].append(fragment);
}

function fillSelect(select, items, valueOf, labelOf, emptyLabel) {
  select.replaceChildren();
  if (!items.length) return select.append(option(emptyLabel, ''));
  select.append(...items.map((item) => option(labelOf(item), valueOf(item))));
}

function option(label, value) { const item = document.createElement('option'); item.textContent = label; item.value = value; return item; }
function empty(text) { const node = document.createElement('div'); node.className = 'empty-state'; node.textContent = text; return node; }
function panelError(id, message) { registry.destroy(elements[id]); const node = empty(message); node.classList.add('error-state'); elements[id].append(node); }
function clearTraffic(message, error = false) { panelError('traffic-chart', message); if (!error) elements['traffic-chart'].querySelector('.error-state')?.classList.remove('error-state'); registry.destroy(elements['snapshot-chart']); elements['snapshot-chart'].append(empty(message)); setText('rx-value', '—'); setText('tx-value', '—'); }
function setBusy(busy) { elements.refresh.disabled = busy; elements.refresh.classList.toggle('busy', busy); }
function setText(id, value) { elements[id].textContent = String(value ?? '—'); }
function showGlobalError(message) { elements['global-error'].textContent = message; elements['global-error'].hidden = false; }
function hideGlobalError() { elements['global-error'].hidden = true; elements['global-error'].textContent = ''; }
function stopPolling() { if (state.poller) clearInterval(state.poller); state.poller = null; }
function stateLabel(value) { return ({ up: '在线', down: '离线', unknown: '未知' })[value] || value; }
function severityLabel(value) { return ({ critical: '严重', warning: '警告', info: '信息', ok: '正常' })[value] || '未知'; }
function timeLabel(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; }
function formatBps(value) { const number = Number(value); if (!Number.isFinite(number)) return '—'; const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']; let scaled = number; let unit = 0; while (Math.abs(scaled) >= 1000 && unit < units.length - 1) { scaled /= 1000; unit += 1; } return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`; }

elements.refresh.addEventListener('click', refreshDashboard);
elements.devices.addEventListener('change', async (event) => { state.selectedDevice = event.target.value; state.selectedPort = ''; await loadPorts(); });
elements.ports.addEventListener('change', async (event) => { state.selectedPort = event.target.value; stopPolling(); renderSnapshot(); await sampleTraffic(); state.poller = setInterval(sampleTraffic, 10_000); });
window.addEventListener('beforeunload', stopPolling);
refreshDashboard();
