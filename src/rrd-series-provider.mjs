import { execFile as execFileCallback } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../contracts.mjs';

const execFile = promisify(execFileCallback);
const MAX_RANGE_SECONDS = 366 * 24 * 3600;
const DEFAULT_MAX_POINTS = 360;
const MAX_SERIES = 12;

const resourceSpecs = new Map([
  ['device_temperature', { prefix: 'sensor-temperature-', dataSource: 'sensor', unit: '°C', title: '温度' }],
  ['device_voltage', { prefix: 'sensor-voltage-', dataSource: 'sensor', unit: 'V', title: '电压' }],
  ['device_current', { prefix: 'sensor-current-', dataSource: 'sensor', unit: 'A', title: '电流' }],
  ['device_power', { prefix: 'sensor-power-', dataSource: 'sensor', unit: 'W', title: '功率' }],
  ['device_dbm', { prefix: 'sensor-dbm-', dataSource: 'sensor', unit: 'dBm', title: '光功率' }],
  ['device_count', { prefix: 'sensor-count-', dataSource: 'sensor', unit: '', title: '计数' }],
  ['device_state', { prefix: 'sensor-state-', dataSource: 'sensor', unit: '', title: '状态' }],
  ['device_processor', { prefix: 'processor-', dataSource: 'usage', unit: '%', title: '处理器使用率' }],
  ['device_storage', { prefix: 'storage-', dataSource: 'used', unit: 'B', title: '存储已用空间' }],
  ['device_mempool', { prefix: 'mempool-', dataSource: 'used', unit: 'B', title: '内存已用空间' }],
  ['device_uptime', { exact: 'uptime.rrd', dataSource: 'uptime', unit: 's', title: '系统运行时间' }],
  ['device_poller_perf', { exact: 'poller-perf.rrd', dataSource: 'poller', unit: 's', title: '轮询耗时' }],
  ['device_icmp_perf', { exact: 'icmp-perf.rrd', dataSource: 'avg', unit: 'ms', title: 'ICMP 响应时间' }],
  ['device_ping_perf', { exact: 'icmp-perf.rrd', dataSource: 'avg', unit: 'ms', title: 'Ping 响应时间' }]
]);

export class RrdSeriesProvider {
  constructor({ hostDir, containerDir = '/data/rrd', container = 'librenms', cacheTtlMs = 30_000, clock = () => Date.now(), run = runRrdTool, listFiles = readdir } = {}) {
    this.hostDir = String(hostDir || '');
    this.containerDir = String(containerDir || '/data/rrd').replace(/\/$/, '');
    this.container = String(container || 'librenms');
    this.cacheTtlMs = cacheTtlMs;
    this.clock = clock;
    this.run = run;
    this.listFiles = listFiles;
    this.cache = new Map();
  }

  get configured() { return Boolean(this.hostDir && this.container && this.containerDir); }

  supportsResource(type) { return resourceSpecs.has(String(type)); }

  async portTrafficSeries({ hostname, portId, from = '-24h', to = 'now', maxPoints = DEFAULT_MAX_POINTS }) {
    const safePortId = safeToken(portId, 'portId');
    return this.#export({
      hostname, from, to, maxPoints,
      id: `port-history:${safePortId}`,
      title: `端口 ${safePortId} 历史流量`, unit: 'bps',
      definitions: [
        { file: `port-id${safePortId}.rrd`, dataSource: 'INOCTETS', name: '入方向', multiplier: 8 },
        { file: `port-id${safePortId}.rrd`, dataSource: 'OUTOCTETS', name: '出方向', multiplier: 8 }
      ]
    });
  }

  async resourceSeries({ hostname, resourceType, from = '-24h', to = 'now', maxPoints = DEFAULT_MAX_POINTS }) {
    const type = safeToken(resourceType, 'resourceType');
    const spec = resourceSpecs.get(type);
    if (!spec) throw new AppError(422, 'MONITORING_SERIES_UNAVAILABLE', '该资源暂不支持数据化历史图表');
    const files = (await this.#files(hostname))
      .filter((file) => file.endsWith('.rrd') && (spec.exact ? file === spec.exact : file.startsWith(spec.prefix)))
      .sort()
      .slice(0, MAX_SERIES);
    if (!files.length) throw new AppError(404, 'MONITORING_SERIES_NOT_FOUND', '该资源没有可用的 RRD 历史数据');
    return this.#export({
      hostname, from, to, maxPoints, id: `resource:${type}`, title: spec.title, unit: spec.unit,
      definitions: files.map((file) => ({ file, dataSource: spec.dataSource, name: seriesLabel(file, spec) }))
    });
  }

  async #files(hostname) {
    const safeHostname = safeSegment(hostname, 'hostname');
    const root = resolve(this.hostDir);
    const directory = resolve(root, safeHostname);
    if (directory !== root && !directory.startsWith(`${root}${sep}`)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', 'hostname is invalid');
    try { return await this.listFiles(directory); }
    catch (error) { throw new AppError(404, 'MONITORING_SERIES_NOT_FOUND', '设备没有可用的 RRD 历史数据', { cause: error }); }
  }

  async #export({ hostname, from, to, maxPoints, id, title, unit, definitions }) {
    if (!this.configured) throw new AppError(503, 'MONITORING_RRD_NOT_CONFIGURED', 'RRD 时序导出尚未配置');
    const safeHostname = safeSegment(hostname, 'hostname');
    const range = normalizeRange(from, to, this.clock());
    const rows = boundedInteger(maxPoints, 60, 480, DEFAULT_MAX_POINTS);
    const cacheKey = JSON.stringify([safeHostname, range.start, range.end, rows, definitions]);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.clock()) return cached.value;

    const args = ['exec', this.container, 'rrdtool', 'xport', '--json', '--start', String(range.start), '--end', String(range.end), '--maxrows', String(rows)];
    definitions.forEach((definition, index) => {
      const source = `v${index}`;
      const file = `${this.containerDir}/${safeHostname}/${definition.file}`;
      args.push(`DEF:${source}=${file}:${definition.dataSource}:AVERAGE`);
      if (definition.multiplier) {
        const converted = `c${index}`;
        args.push(`CDEF:${converted}=${source},${definition.multiplier},*`, `XPORT:${converted}:${safeLegend(definition.name)}`);
      } else args.push(`XPORT:${source}:${safeLegend(definition.name)}`);
    });

    let parsed;
    try { parsed = JSON.parse(await this.run(args)); }
    catch (error) { throw new AppError(502, 'MONITORING_RRD_EXPORT_FAILED', 'RRD 历史数据导出失败', { cause: error }); }
    const step = Number(parsed?.meta?.step);
    const start = Number(parsed?.meta?.start);
    if (!Number.isFinite(step) || !Number.isFinite(start) || !Array.isArray(parsed?.data)) {
      throw new AppError(502, 'MONITORING_RRD_INVALID_RESPONSE', 'RRD 返回的数据格式无效');
    }
    const series = definitions.map((definition, seriesIndex) => ({
      id: `series-${seriesIndex}`,
      name: definition.name,
      points: parsed.data.map((row, rowIndex) => [start + step * (rowIndex + 1), finiteOrNull(row?.[seriesIndex])])
    }));
    const value = {
      id, title, unit, sampledAt: new Date(this.clock()).toISOString(), sampleMode: 'rrd-xport',
      range: { from: new Date(range.start * 1000).toISOString(), to: new Date(range.end * 1000).toISOString(), stepSeconds: step },
      series
    };
    this.cache.set(cacheKey, { expiresAt: this.clock() + this.cacheTtlMs, value });
    return value;
  }
}

async function runRrdTool(args) {
  const { stdout } = await execFile('docker', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout;
}

function normalizeRange(from, to, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const toText = String(to ?? '').trim();
  const end = !toText || toText === 'now' ? Math.floor(now / 30) * 30 : parseBoundary(toText, now, now);
  const start = parseBoundary(from, end, end - 24 * 3600);
  if (start >= end || end - start > MAX_RANGE_SECONDS) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', '时间范围无效或超过 366 天');
  return { start, end };
}

function parseBoundary(value, anchor, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (text === 'now') return anchor;
  const relative = text.match(/^-(\d{1,5})([smhdw])$/);
  if (relative) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[relative[2]];
    return anchor - Number(relative[1]) * unit;
  }
  if (/^\d{1,12}$/.test(text)) return Number(text);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', '时间参数无效');
  return Math.floor(timestamp / 1000);
}

function safeSegment(value, field) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\0]/.test(text)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', `${field} is invalid`);
  return text;
}

function safeToken(value, field) {
  const text = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(text)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', `${field} is invalid`);
  return text;
}

function safeLegend(value) { return String(value || 'series').replace(/[:\r\n]/g, ' ').slice(0, 120); }
function finiteOrNull(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function boundedInteger(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback; }
function seriesLabel(file, spec) { return file.replace(/\.rrd$/, '').replace(spec.prefix || '', '').replace(/[-_]+/g, ' ').slice(0, 80); }

export const rrdSeriesInternals = { normalizeRange, resourceSpecs };
