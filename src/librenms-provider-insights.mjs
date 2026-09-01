import { AppError, finiteNumber, isoTime, normalizeSeverity, normalizeState, requireIdentifier } from '../contracts.mjs';
import { LibreNmsProvider as BaseLibreNmsProvider } from './librenms-provider.mjs';

const rankingPortColumns = [
  'port_id', 'device_id', 'ifName', 'ifDescr', 'ifAlias', 'ifOperStatus', 'ifAdminStatus',
  'ifSpeed', 'ifInOctets_rate', 'ifOutOctets_rate',
  'ifInErrors_delta', 'ifOutErrors_delta',
  'poll_time', 'poll_period'
].join(',');

const graphTypePattern = /^[a-zA-Z0-9_-]{1,96}$/;

export class LibreNmsProvider extends BaseLibreNmsProvider {
  constructor(options) {
    super(options);
    this.rrdSeries = options?.rrdSeries || null;
  }

  async listAllPorts() {
    const body = await this.request('/ports', new URLSearchParams({ columns: rankingPortColumns }));
    return arrayOf(body.ports).map(normalizeRankedPort);
  }

  async listDeviceResources(deviceId) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const encoded = encodeURIComponent(id);
    const [deviceGraphs, healthGraphs, availability] = await Promise.all([
      this.request(`/devices/${encoded}/graphs`),
      this.request(`/devices/${encoded}/health`),
      this.request(`/devices/${encoded}/availability`)
    ]);
    const graphs = [
      ...arrayOf(deviceGraphs.graphs).map((item) => normalizeGraphDescriptor(item, 'device')),
      ...arrayOf(healthGraphs.graphs).map((item) => normalizeGraphDescriptor(item, 'health'))
    ].map((graph) => ({ ...graph, seriesAvailable: Boolean(this.rrdSeries?.supportsResource(graph.id)) }));
    return {
      deviceId: id,
      graphs,
      availability: arrayOf(availability.availability).map((item) => ({
        durationSeconds: finiteNumber(item.duration) ?? 0,
        percent: finiteNumber(item.availability_perc) ?? 0
      }))
    };
  }

  async listDeviceResourceSensors(deviceId, resourceType, { limit = 40 } = {}) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const type = requireGraphType(resourceType, 'resourceType');
    const sensorClass = type.replace(/^device_/, '');
    const body = await this.request('/resources/sensors');
    return arrayOf(body.sensors)
      .filter((sensor) => String(sensor.device_id) === id && String(sensor.sensor_class) === sensorClass && !Number(sensor.sensor_deleted))
      .slice(0, boundedInteger(limit, 1, 100, 40))
      .map((sensor) => normalizeResourceSensor(sensor, type));
  }

  async getDeviceResourceSeries(deviceId, resourceType, options = {}) {
    const device = await this.findDevice(deviceId);
    return this.requireRrdSeries().resourceSeries({ hostname: device.hostname, resourceType, ...options });
  }

  async getPortHistorySeries(deviceId, portId, options = {}) {
    const [device, ports] = await Promise.all([this.findDevice(deviceId), this.listPorts(deviceId)]);
    const safePortId = requireIdentifier(portId, 'portId');
    const port = ports.find((item) => item.id === safePortId || item.name === safePortId);
    if (!port) throw new AppError(404, 'MONITORING_PORT_NOT_FOUND', 'Port was not found');
    return this.requireRrdSeries().portTrafficSeries({ hostname: device.hostname, portId: port.id, ...options });
  }

  async findDevice(deviceId) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const device = (await this.listDevices()).find((item) => item.id === id || item.hostname === id);
    if (!device) throw new AppError(404, 'MONITORING_DEVICE_NOT_FOUND', 'Device was not found');
    return device;
  }

  requireRrdSeries() {
    if (!this.rrdSeries?.configured) throw new AppError(503, 'MONITORING_RRD_NOT_CONFIGURED', 'RRD 时序导出尚未配置');
    return this.rrdSeries;
  }

  async listArp(deviceId) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const body = await this.request('/resources/ip/arp/all', new URLSearchParams({ device: id }));
    return arrayOf(body.arp).map(normalizeArp);
  }

  async listEventLog(deviceId, { from, to, limit = 50 } = {}) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const query = new URLSearchParams({ limit: String(boundedInteger(limit, 1, 100, 50)) });
    if (from) query.set('from', normalizeTimeBoundary(from, 'from'));
    if (to) query.set('to', normalizeTimeBoundary(to, 'to'));
    const body = await this.request(`/logs/eventlog/${encodeURIComponent(id)}`, query);
    return arrayOf(body.logs ?? body.events).map(normalizeEvent);
  }

  async getDeviceGraph(deviceId, category, graphType, options = {}) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const type = requireGraphType(graphType, 'graphType');
    if (!['device', 'health'].includes(category)) {
      throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', 'graph category is invalid');
    }
    const path = category === 'health'
      ? `/devices/${encodeURIComponent(id)}/graphs/health/${encodeURIComponent(type)}`
      : `/devices/${encodeURIComponent(id)}/${encodeURIComponent(type)}`;
    return this.requestBinary(path, graphQuery(options));
  }

  async getPortGraph(deviceId, portName, graphType = 'port_bits', options = {}) {
    const id = requireIdentifier(deviceId, 'deviceId');
    const port = requireIdentifier(portName, 'portName');
    const type = requireGraphType(graphType, 'graphType');
    return this.requestBinary(
      `/devices/${encodeURIComponent(id)}/ports/${encodeURIComponent(port)}/${encodeURIComponent(type)}`,
      graphQuery(options)
    );
  }

  async requestBinary(path, search = new URLSearchParams()) {
    if (!this.token) throw new AppError(503, 'MONITORING_PROVIDER_NOT_CONFIGURED', 'LibreNMS provider is not configured');
    const url = `${this.baseUrl}/api/v0${path}${search.size ? `?${search}` : ''}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'X-Auth-Token': this.token, accept: 'image/png,image/svg+xml' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new AppError(502, 'MONITORING_PROVIDER_UNAVAILABLE', 'LibreNMS did not respond in time', { cause: error });
    }
    if (!response.ok) {
      throw new AppError(502, 'MONITORING_PROVIDER_REJECTED', `LibreNMS graph request failed with HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (contentType !== 'image/png' || declaredLength > 10 * 1024 * 1024) {
      throw new AppError(502, 'MONITORING_PROVIDER_INVALID_RESPONSE', 'LibreNMS returned an invalid graph response');
    }
    const body = Buffer.from(await response.arrayBuffer());
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (body.length > 10 * 1024 * 1024 || pngSignature.some((byte, index) => body[index] !== byte)) {
      throw new AppError(502, 'MONITORING_PROVIDER_INVALID_RESPONSE', 'LibreNMS returned an invalid graph response');
    }
    return { contentType, body };
  }
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function normalizeRankedPort(port) {
  const inBits = finiteNumber(port.ifInBits_rate);
  const outBits = finiteNumber(port.ifOutBits_rate);
  const inOctets = finiteNumber(port.ifInOctets_rate);
  const outOctets = finiteNumber(port.ifOutOctets_rate);
  return {
    id: String(port.port_id ?? port.ifName ?? ''),
    deviceId: String(port.device_id ?? ''),
    name: String(port.ifName ?? port.ifDescr ?? port.port_id ?? ''),
    description: String(port.ifAlias ?? port.ifDescr ?? ''),
    status: normalizeState(port.ifOperStatus),
    adminStatus: normalizeState(port.ifAdminStatus),
    speedBps: finiteNumber(port.ifSpeed),
    rxBps: inBits ?? (inOctets === null ? null : inOctets * 8),
    txBps: outBits ?? (outOctets === null ? null : outOctets * 8),
    errors: sumNumbers(port.ifInErrors_delta, port.ifOutErrors_delta),
    discards: sumNumbers(port.ifInDiscards_delta, port.ifOutDiscards_delta),
    polledAt: isoTime(port.poll_time),
    pollIntervalSeconds: finiteNumber(port.poll_period)
  };
}

function normalizeGraphDescriptor(graph, category) {
  const id = String(graph.name ?? graph.type ?? '');
  return { id, name: String(graph.desc ?? graph.description ?? id), category };
}

function normalizeResourceSensor(sensor, resourceType) {
  const current = finiteNumber(sensor.sensor_current, sensor.processor_usage, sensor.mempool_perc, sensor.storage_perc);
  return {
    id: String(sensor.sensor_id ?? sensor.processor_id ?? sensor.mempool_id ?? sensor.storage_id ?? ''),
    resourceType,
    name: String(sensor.sensor_descr ?? sensor.processor_descr ?? sensor.mempool_descr ?? sensor.storage_descr ?? sensor.desc ?? resourceType),
    current,
    previous: finiteNumber(sensor.sensor_prev),
    unit: resourceUnit(resourceType, sensor.sensor_class),
    warningHigh: finiteNumber(sensor.sensor_limit_warn),
    criticalHigh: finiteNumber(sensor.sensor_limit),
    warningLow: finiteNumber(sensor.sensor_limit_low_warn),
    criticalLow: finiteNumber(sensor.sensor_limit_low),
    status: sensorStatus(current, sensor),
    updatedAt: isoTime(sensor.lastupdate ?? sensor.updated_at)
  };
}

function normalizeArp(entry) {
  return {
    portId: String(entry.port_id ?? ''),
    macAddress: formatMac(entry.mac_address),
    ipAddress: String(entry.ipv4_address ?? entry.ip_address ?? ''),
    context: String(entry.context_name ?? '')
  };
}

function normalizeEvent(event) {
  return {
    id: String(event.event_id ?? event.id ?? ''),
    deviceId: String(event.device_id ?? ''),
    type: String(event.type ?? event.event_type ?? 'event'),
    severity: normalizeSeverity(event.severity ?? event.level),
    message: String(event.message ?? event.msg ?? event.event_message ?? ''),
    timestamp: isoTime(event.datetime ?? event.timestamp ?? event.created_at)
  };
}

function sumNumbers(...values) {
  const numbers = values.map((value) => finiteNumber(value)).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : 0;
}

function requireGraphType(value, field) {
  const normalized = String(value ?? '').trim();
  if (!graphTypePattern.test(normalized)) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', `${field} is invalid`);
  return normalized;
}

function graphQuery({ from = '-24h', to = 'now', width = 1000, height = 280 } = {}) {
  return new URLSearchParams({
    from: normalizeTimeBoundary(from, 'from'),
    to: normalizeTimeBoundary(to, 'to'),
    width: String(boundedInteger(width, 320, 2000, 1000)),
    height: String(boundedInteger(height, 160, 1000, 280)),
    graph_type: 'png'
  });
}

function normalizeTimeBoundary(value, field) {
  const normalized = String(value ?? '').trim();
  if (normalized === 'now' || /^-\d{1,5}[smhdwy]$/.test(normalized) || /^\d{1,12}$/.test(normalized)) return normalized;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new AppError(400, 'MONITORING_INVALID_ARGUMENT', `${field} is invalid`);
  return String(Math.floor(date.getTime() / 1000));
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function resourceUnit(type, sensorClass) {
  const value = `${type} ${sensorClass || ''}`.toLowerCase();
  if (/(processor|mempool|storage|humidity|percent)/.test(value)) return '%';
  if (/temperature/.test(value)) return '°C';
  if (/voltage/.test(value)) return 'V';
  if (/current/.test(value)) return 'A';
  if (/power/.test(value)) return 'W';
  if (/fanspeed/.test(value)) return 'rpm';
  return '';
}

function sensorStatus(current, sensor) {
  if (current === null) return 'unknown';
  const criticalHigh = finiteNumber(sensor.sensor_limit);
  const warningHigh = finiteNumber(sensor.sensor_limit_warn);
  const criticalLow = finiteNumber(sensor.sensor_limit_low);
  const warningLow = finiteNumber(sensor.sensor_limit_low_warn);
  if ((criticalHigh !== null && current > criticalHigh) || (criticalLow !== null && current < criticalLow)) return 'critical';
  if ((warningHigh !== null && current > warningHigh) || (warningLow !== null && current < warningLow)) return 'warning';
  return 'ok';
}

function formatMac(value) {
  const compact = String(value ?? '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  return compact.length === 12 ? compact.match(/.{2}/g).join(':') : String(value ?? '');
}

export const libreNmsInsightNormalizers = {
  normalizeRankedPort, normalizeResourceSensor, normalizeArp, normalizeEvent
};
