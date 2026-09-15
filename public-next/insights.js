import { RendererRegistry } from './renderers/renderer-registry.js';
import { chartJsRenderer } from './renderers/chartjs-renderer.js';
import { uPlotRenderer } from './renderers/uplot-renderer.js';
import { createRequestId } from './request-id.js';

const registry = new RendererRegistry().register(chartJsRenderer).register(uPlotRenderer);
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'provider-dot', 'provider-label', 'updated-at', 'refresh', 'global-error', 'device-total', 'device-up', 'device-down',
  'alert-active', 'alert-critical', 'port-total', 'resource-device', 'resource-type', 'from-time', 'to-time',
  'apply-resource-time', 'availability', 'resource-graph', 'sensor-list', 'ranking-metric', 'ranking-status',
  'ranking-limit', 'ranking-chart', 'ranking-rows', 'ranking-value-label', 'port-device', 'port-select', 'port-range',
  'live-state', 'live-rx', 'live-tx', 'live-chart', 'port-history', 'arp-rows', 'event-list'
].map((id) => [id, byId(id)]));

const state = { devices: [], ports: [], resources: [], selectedPort: null, poller: null };

setDefaultTimes();
bindEvents();
await refreshAll();

async function request(path) {
  const response = await fetch(path, { headers: { accept: 'application/json', 'x-request-id': createRequestId() } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败（HTTP ${response.status}）`);
  return body;
}

async function refreshAll() {
  hideError();
  const [health, overview, devices, ranking] = await Promise.allSettled([
    request('/api/v1/monitoring/health'), request('/api/v1/monitoring/overview'),
    request('/api/v1/monitoring/devices'), loadRanking()
  ]);
  if (health.status === 'fulfilled') renderHealth(health.value); else showError(health.reason);
  if (overview.status === 'fulfilled') renderOverview(overview.value); else showError(overview.reason);
  if (devices.status === 'fulfilled') setDevices(devices.value.items || []); else showError(devices.reason);
  if (ranking.status === 'rejected') showError(ranking.reason);
  elements['updated-at'].textContent = `同步于 ${new Date().toLocaleTimeString()}`;
}

function renderHealth(health) {
  const up = health.status === 'up';
  elements['provider-dot'].classList.toggle('up', up);
  elements['provider-label'].textContent = health.provider?.name || 'LibreNMS';
}

function renderOverview(overview) {
  elements['device-total'].textContent = overview.devices?.total ?? 0;
  elements['device-up'].textContent = overview.devices?.up ?? 0;
  elements['device-down'].textContent = overview.devices?.down ?? 0;
  elements['alert-active'].textContent = overview.alerts?.active ?? 0;
  elements['alert-critical'].textContent = overview.alerts?.severities?.critical ?? 0;
}

function setDevices(devices) {
  state.devices = devices;
  fillSelect(elements['resource-device'], devices, (item) => item.id, (item) => item.name, '请选择设备');
  fillSelect(elements['port-device'], devices, (item) => item.id, (item) => item.name, '请选择设备');
  const first = devices[0]?.id;
  if (first) {
    elements['resource-device'].value = first;
    elements['port-device'].value = first;
    loadResources();
    loadPorts();
  }
}

async function loadResources() {
  const deviceId = elements['resource-device'].value;
  state.resources = [];
  clearElement(elements['resource-type'], '读取中…');
  showEmpty(elements['resource-graph'], deviceId ? '读取资源目录…' : '请选择设备');
  showEmpty(elements['sensor-list'], '选择健康资源后显示当前值');
  if (!deviceId) return;
  try {
    const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/resources`);
    state.resources = (body.graphs || []).filter((item) => item.seriesAvailable);
    fillSelect(elements['resource-type'], state.resources, (item) => `${item.category}:${item.id}`, (item) => `${item.category === 'health' ? '健康' : '设备'} · ${item.name}`, '请选择资源');
    renderAvailability(body.availability || []);
    if (state.resources[0]) {
      elements['resource-type'].value = `${state.resources[0].category}:${state.resources[0].id}`;
      renderSelectedResource();
    } else showEmpty(elements['resource-graph'], '该设备没有可数据化的历史资源');
  } catch (error) { showError(error); showEmpty(elements['resource-graph'], error.message); }
}

function renderAvailability(items) {
  elements.availability.replaceChildren();
  if (!items.length) return appendText(elements.availability, '暂无可用率数据', 'muted');
  for (const item of items) {
    const span = document.createElement('span');
    const duration = item.durationSeconds >= 86400 ? `${Math.round(item.durationSeconds / 86400)}天` : `${Math.round(item.durationSeconds / 3600)}小时`;
    span.append(document.createTextNode(`${duration} `));
    const strong = document.createElement('b');
    strong.textContent = `${Number(item.percent).toFixed(2)}%`;
    span.append(strong);
    elements.availability.append(span);
  }
}

async function renderSelectedResource() {
  const [category, ...typeParts] = elements['resource-type'].value.split(':');
  const type = typeParts.join(':');
  const deviceId = elements['resource-device'].value;
  if (!deviceId || !type) return;
  const range = selectedResourceRange();
  showEmpty(elements['resource-graph'], '读取历史指标…');
  try {
    const frame = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/resources/${encodeURIComponent(type)}/series?${range}`);
    registry.render(elements['resource-graph'], { engine: 'uplot', kind: 'timeseries', title: frame.title, unit: frame.unit, series: frame.series });
  } catch (error) { showEmpty(elements['resource-graph'], error.message); }
  if (category !== 'health') return showEmpty(elements['sensor-list'], '该资源暂无标准化当前值');
  showEmpty(elements['sensor-list'], '读取当前传感器…');
  try {
    const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/resources/${encodeURIComponent(type)}/sensors?limit=40`);
    renderSensors(body.items || []);
  } catch (error) { showEmpty(elements['sensor-list'], error.message); }
}

function renderSensors(items) {
  elements['sensor-list'].replaceChildren();
  if (!items.length) return showEmpty(elements['sensor-list'], '没有传感器数据');
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `sensor-row ${item.status || 'unknown'}`;
    const detail = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = item.name;
    const updated = document.createElement('small'); updated.textContent = item.updatedAt ? `更新 ${formatTime(item.updatedAt)}` : '更新时间未知';
    detail.append(name, updated);
    const value = document.createElement('span'); value.className = 'sensor-value'; value.textContent = `${formatNumber(item.current)}${item.unit || ''}`;
    row.append(detail, value); elements['sensor-list'].append(row);
  }
}

async function loadRanking() {
  const metric = elements['ranking-metric'].value;
  const query = new URLSearchParams({ metric, status: elements['ranking-status'].value, limit: elements['ranking-limit'].value });
  const body = await request(`/api/v1/monitoring/ports/rankings?${query}`);
  elements['port-total'].textContent = body.total ?? body.items?.length ?? 0;
  renderRanking(body.items || [], metric);
  return body;
}

function renderRanking(items, metric) {
  const labels = { traffic: '总流量', utilization: '利用率', errors: '错误数', discards: '丢弃数' };
  elements['ranking-value-label'].textContent = labels[metric];
  registry.render(elements['ranking-chart'], {
    engine: 'chartjs', kind: 'bar', title: `端口${labels[metric]}排行`, unit: metric === 'traffic' ? 'bps' : '', legend: false,
    labels: items.slice(0, 12).map((item) => `${item.deviceName} / ${item.name}`),
    datasets: [{ name: labels[metric], values: items.slice(0, 12).map((item) => item.rankingValue) }]
  });
  elements['ranking-rows'].replaceChildren();
  if (!items.length) return tableMessage(elements['ranking-rows'], 4, '没有符合条件的端口');
  for (const item of items) {
    const row = document.createElement('tr');
    addCell(row, item.rank);
    const identity = document.createElement('td'); identity.textContent = `${item.deviceName} / ${item.name}`;
    const description = document.createElement('small'); description.textContent = item.description || item.id; identity.append(description); row.append(identity);
    const status = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status ${item.status}`; badge.textContent = item.status; status.append(badge); row.append(status);
    addCell(row, formatRanking(item.rankingValue, metric));
    elements['ranking-rows'].append(row);
  }
}

async function loadPorts() {
  stopPolling();
  const deviceId = elements['port-device'].value;
  state.ports = []; state.selectedPort = null;
  clearElement(elements['port-select'], deviceId ? '读取端口…' : '请选择设备');
  resetPortViews();
  if (!deviceId) return;
  try {
    const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/ports`);
    state.ports = body.items || [];
    fillSelect(elements['port-select'], state.ports, (item) => item.id, (item) => `${item.name}${item.description ? ` · ${item.description}` : ''}`, '请选择端口');
    const preferred = state.ports.find((port) => port.status === 'up' && ((Number(port.rxBps) || 0) + (Number(port.txBps) || 0) > 0))
      || state.ports.find((port) => port.status === 'up' && (Number.isFinite(port.rxBps) || Number.isFinite(port.txBps)))
      || state.ports.find((port) => port.status === 'up') || state.ports[0];
    if (preferred) { elements['port-select'].value = preferred.id; selectPort(); }
  } catch (error) { showError(error); }
}

async function selectPort() {
  stopPolling();
  const portId = elements['port-select'].value;
  state.selectedPort = state.ports.find((port) => port.id === portId) || null;
  if (!state.selectedPort) return resetPortViews();
  elements['live-state'].textContent = state.selectedPort.status;
  await Promise.allSettled([sampleTraffic(), updatePortHistory(), loadArp(), loadEvents()]);
  state.poller = setInterval(sampleTraffic, 30_000);
}

async function sampleTraffic() {
  if (!state.selectedPort) return;
  const deviceId = elements['port-device'].value;
  const query = new URLSearchParams({ from: '-1h', to: 'now', maxPoints: '120' });
  try {
    const frame = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/ports/${encodeURIComponent(state.selectedPort.id)}/series?${query}`);
    elements['live-rx'].textContent = formatBps(lastFinite(frame.series[0]?.points));
    elements['live-tx'].textContent = formatBps(lastFinite(frame.series[1]?.points));
    registry.render(elements['live-chart'], { engine: 'uplot', kind: 'timeseries', title: frame.title, unit: frame.unit, series: frame.series });
  } catch (error) { showEmpty(elements['live-chart'], error.message); }
}

async function updatePortHistory() {
  if (!state.selectedPort) return;
  const deviceId = elements['port-device'].value;
  const query = new URLSearchParams({ from: elements['port-range'].value, to: 'now', maxPoints: '360' });
  showEmpty(elements['port-history'], '读取历史流量…');
  try {
    const frame = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/ports/${encodeURIComponent(state.selectedPort.id)}/series?${query}`);
    registry.render(elements['port-history'], { engine: 'uplot', kind: 'timeseries', title: frame.title, unit: frame.unit, series: frame.series });
  } catch (error) { showEmpty(elements['port-history'], error.message); }
}

async function loadArp() {
  const deviceId = elements['port-device'].value;
  const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/ports/${encodeURIComponent(state.selectedPort.id)}/arp`);
  elements['arp-rows'].replaceChildren();
  if (!body.items?.length) return tableMessage(elements['arp-rows'], 3, '该端口没有ARP记录');
  for (const item of body.items) {
    const row = document.createElement('tr'); addCell(row, item.ipAddress); addCell(row, item.macAddress); addCell(row, item.context || '—'); elements['arp-rows'].append(row);
  }
}

async function loadEvents() {
  const deviceId = elements['port-device'].value;
  const body = await request(`/api/v1/monitoring/devices/${encodeURIComponent(deviceId)}/events?limit=100`);
  const name = state.selectedPort.name.toLowerCase();
  const id = state.selectedPort.id.toLowerCase();
  const items = (body.items || []).filter((item) => `${item.message} ${item.type}`.toLowerCase().includes(name) || `${item.message}`.toLowerCase().includes(id));
  elements['event-list'].replaceChildren();
  if (!items.length) return showEmpty(elements['event-list'], '没有可明确关联到该端口的事件');
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'event';
    const message = document.createElement('strong'); message.textContent = item.message;
    const meta = document.createElement('small'); meta.textContent = `${item.type} · ${item.timestamp ? formatTime(item.timestamp) : '时间未知'}`;
    row.append(message, meta); elements['event-list'].append(row);
  }
}

function bindEvents() {
  elements.refresh.addEventListener('click', refreshAll);
  elements['resource-device'].addEventListener('change', loadResources);
  elements['resource-type'].addEventListener('change', renderSelectedResource);
  elements['apply-resource-time'].addEventListener('click', renderSelectedResource);
  for (const id of ['ranking-metric', 'ranking-status', 'ranking-limit']) elements[id].addEventListener('change', () => loadRanking().catch(showError));
  elements['port-device'].addEventListener('change', loadPorts);
  elements['port-select'].addEventListener('change', selectPort);
  elements['port-range'].addEventListener('change', () => updatePortHistory());
  addEventListener('beforeunload', () => { stopPolling(); registry.destroy(elements['ranking-chart']); registry.destroy(elements['live-chart']); });
}

function selectedResourceRange() {
  const from = elements['from-time'].value ? new Date(elements['from-time'].value).toISOString() : '-24h';
  const to = elements['to-time'].value ? new Date(elements['to-time'].value).toISOString() : 'now';
  return new URLSearchParams({ from, to, maxPoints: '360' });
}

function setDefaultTimes() {
  const now = new Date(); const before = new Date(now.getTime() - 24 * 3600 * 1000);
  elements['to-time'].value = toLocalInput(now); elements['from-time'].value = toLocalInput(before);
}

function toLocalInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function resetPortViews() {
  elements['live-state'].textContent = '等待选择'; elements['live-rx'].textContent = '—'; elements['live-tx'].textContent = '—';
  showEmpty(elements['live-chart'], '请选择端口'); showEmpty(elements['port-history'], '请选择端口');
  elements['arp-rows'].replaceChildren(); tableMessage(elements['arp-rows'], 3, '请选择端口'); showEmpty(elements['event-list'], '请选择端口');
}

function fillSelect(select, items, valueOf, labelOf, placeholder) {
  select.replaceChildren(); const option = new Option(placeholder, ''); select.append(option);
  for (const item of items) select.append(new Option(labelOf(item), valueOf(item)));
}

function clearElement(element, message) { element.replaceChildren(new Option(message, '')); }
function clearContainer(element) { element.replaceChildren(); element.classList.remove('empty-state'); }
function showEmpty(element, message) { element.replaceChildren(); element.classList.add('empty-state'); element.textContent = message; }
function appendText(element, text, className) { const span = document.createElement('span'); span.className = className; span.textContent = text; element.append(span); }
function addCell(row, value) { const cell = document.createElement('td'); cell.textContent = value ?? '—'; row.append(cell); }
function tableMessage(body, columns, message) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = message; row.append(cell); body.append(row); }
function stopPolling() { if (state.poller) clearInterval(state.poller); state.poller = null; }
function showError(error) { elements['global-error'].hidden = false; elements['global-error'].textContent = error?.message || String(error); }
function hideError() { elements['global-error'].hidden = true; elements['global-error'].textContent = ''; }
function formatTime(value) { return new Date(value).toLocaleString(); }
function formatNumber(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
function formatRanking(value, metric) { return metric === 'traffic' ? formatBps(value) : metric === 'utilization' ? `${formatNumber(value)}%` : formatNumber(value); }
function formatBps(value) {
  if (value === null || value === undefined || value === '') return '—';
  let number = Number(value); if (!Number.isFinite(number)) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']; let unit = 0;
  while (Math.abs(number) >= 1000 && unit < units.length - 1) { number /= 1000; unit += 1; }
  return `${number.toFixed(number >= 100 ? 0 : 1)} ${units[unit]}`;
}
function lastFinite(points = []) { for (let index = points.length - 1; index >= 0; index -= 1) { if (Number.isFinite(points[index]?.[1])) return points[index][1]; } return null; }
