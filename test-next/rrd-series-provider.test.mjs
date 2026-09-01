import test from 'node:test';
import assert from 'node:assert/strict';
import { RrdSeriesProvider } from '../src/providers/rrd-series-provider.mjs';

function sampleXport() {
  return JSON.stringify({ meta: { start: 1_700_000_000, end: 1_700_000_600, step: 300, legend: ['Inbound', 'Outbound'] }, data: [[10, 20], [null, 40]] });
}

test('exports port RRD values as bounded renderer-neutral bps series', async () => {
  let args;
  const provider = new RrdSeriesProvider({
    hostDir: '/rrd', containerDir: '/data/rrd', container: 'librenms', clock: () => 1_700_000_600_000,
    run: async (value) => { args = value; return sampleXport(); }
  });
  const frame = await provider.portTrafficSeries({ hostname: 'router-1', portId: '9', from: '-10m', maxPoints: 999 });
  assert.deepEqual(frame.series[0].points, [[1_700_000_300, 10], [1_700_000_600, null]]);
  assert.equal(frame.sampleMode, 'rrd-xport');
  assert.deepEqual(args.slice(0, 5), ['exec', 'librenms', 'rrdtool', 'xport', '--json']);
  assert.ok(args.includes('480'));
  assert.ok(args.some((value) => value.includes('/data/rrd/router-1/port-id9.rrd:INOCTETS:AVERAGE')));
  assert.ok(args.includes('CDEF:c0=v0,8,*'));
});

test('exports only supported resource files, caches results and rejects traversal', async () => {
  let calls = 0;
  const provider = new RrdSeriesProvider({
    hostDir: '/rrd', clock: () => 1_700_000_600_000,
    listFiles: async () => ['sensor-temperature-z.rrd', 'sensor-temperature-a.rrd', 'port-id9.rrd'],
    run: async () => { calls += 1; return JSON.stringify({ meta: { start: 1_700_000_000, step: 300 }, data: [[21, 22]] }); }
  });
  const frame = await provider.resourceSeries({ hostname: 'router-1', resourceType: 'device_temperature' });
  assert.equal(frame.unit, '°C');
  assert.deepEqual(frame.series.map((item) => item.name), ['a', 'z']);
  await provider.resourceSeries({ hostname: 'router-1', resourceType: 'device_temperature' });
  assert.equal(calls, 1);
  await assert.rejects(() => provider.portTrafficSeries({ hostname: '../secret', portId: '9' }), { code: 'MONITORING_INVALID_ARGUMENT' });
});

test('aligns now to a 30 second cache window', async () => {
  let now = 1_700_000_610_000;
  let calls = 0;
  const provider = new RrdSeriesProvider({
    hostDir: '/rrd', clock: () => now,
    run: async () => { calls += 1; return sampleXport(); }
  });
  await provider.portTrafficSeries({ hostname: 'router-1', portId: '9', from: '-1h' });
  now += 20_000;
  await provider.portTrafficSeries({ hostname: 'router-1', portId: '9', from: '-1h' });
  assert.equal(calls, 1);
});
