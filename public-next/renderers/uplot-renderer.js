const colors = ['#1dd3b0', '#60a5fa', '#fb7185'];

export const uPlotRenderer = {
  id: 'uplot',
  supports: (spec) => spec.kind === 'timeseries',
  render(element, spec) {
    if (!globalThis.uPlot) throw new Error('uPlot is not available');
    const data = toAlignedData(spec.series);
    const options = {
      title: '',
      width: Math.max(element.clientWidth, 320),
      height: Math.max(element.clientHeight, 280),
      cursor: { drag: { x: true, y: false, setScale: true } },
      scales: { x: { time: true }, y: { auto: true } },
      legend: { show: true, live: true },
      padding: [12, 18, 4, 8],
      axes: [
        { size: 52, gap: 10, space: 90, stroke: '#526175', grid: { stroke: 'rgba(82,97,117,.14)' }, values: (_u, values) => values.map(formatTimestamp) },
        { size: 82, gap: 8, stroke: '#526175', grid: { stroke: 'rgba(82,97,117,.14)' }, values: (_u, values) => values.map((value) => formatValue(value, spec.unit)) }
      ],
      series: [
        {},
        ...spec.series.map((series, index) => ({ label: series.name, stroke: colors[index % colors.length], width: 2, spanGaps: true, value: (_u, value) => formatValue(value, spec.unit) }))
      ]
    };
    const plot = new globalThis.uPlot(options, data, element);
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width > 0) plot.setSize({ width, height: Math.max(element.clientHeight, 280) });
    });
    observer.observe(element);
    return { destroy() { observer.disconnect(); plot.destroy(); } };
  }
};

function toAlignedData(series) {
  const timestamps = [...new Set(series.flatMap((item) => item.points.map(([time]) => time)))].sort((a, b) => a - b);
  return [timestamps, ...series.map((item) => {
    const values = new Map(item.points);
    return timestamps.map((time) => values.get(time) ?? null);
  })];
}

function formatBps(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let scaled = number;
  let unit = 0;
  while (Math.abs(scaled) >= 1000 && unit < units.length - 1) { scaled /= 1000; unit += 1; }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatValue(value, unit) {
  if (unit === 'bps') return formatBps(value);
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (unit === 'B') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let scaled = number; let index = 0;
    while (Math.abs(scaled) >= 1024 && index < units.length - 1) { scaled /= 1024; index += 1; }
    return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[index]}`;
  }
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`;
}

function formatTimestamp(value) {
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
