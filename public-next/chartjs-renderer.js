const palette = ['#1dd3b0', '#ffb703', '#fb7185', '#60a5fa', '#a78bfa', '#94a3b8'];

export const chartJsRenderer = {
  id: 'chartjs',
  supports: (spec) => ['doughnut', 'bar', 'line'].includes(spec.kind),
  render(element, spec) {
    if (!globalThis.Chart) throw new Error('Chart.js is not available');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', spec.title || 'Chart');
    canvas.setAttribute('role', 'img');
    element.append(canvas);
    const chart = new globalThis.Chart(canvas, {
      type: spec.kind,
      data: {
        labels: spec.labels,
        datasets: spec.datasets.map((dataset, index) => ({
          label: dataset.name,
          data: dataset.values,
          backgroundColor: dataset.colors || (spec.kind === 'doughnut' ? palette : color(index, 0.72)),
          borderColor: dataset.borderColor || color(index, 1),
          borderWidth: spec.kind === 'doughnut' ? 0 : 1.5,
          borderRadius: spec.kind === 'bar' ? 6 : 0
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500 },
        plugins: {
          legend: { display: spec.legend !== false, position: 'bottom', labels: { color: '#334155', usePointStyle: true, padding: 18 } },
          tooltip: { callbacks: spec.unit === 'bps' ? { label: (context) => `${context.dataset.label}: ${formatBps(context.raw)}` } : {} }
        },
        scales: spec.kind === 'doughnut' ? {} : {
          x: { ticks: { color: '#526175' }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: '#526175', callback: spec.unit === 'bps' ? formatBps : undefined }, grid: { color: 'rgba(82,97,117,.14)' } }
        },
        cutout: spec.kind === 'doughnut' ? '72%' : undefined
      }
    });
    return { destroy: () => chart.destroy() };
  }
};

function color(index, alpha) {
  const colors = [`rgba(29,211,176,${alpha})`, `rgba(96,165,250,${alpha})`, `rgba(251,113,133,${alpha})`];
  return colors[index % colors.length];
}

function formatBps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let scaled = number;
  let unit = 0;
  while (Math.abs(scaled) >= 1000 && unit < units.length - 1) { scaled /= 1000; unit += 1; }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}
