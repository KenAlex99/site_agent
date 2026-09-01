import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app-insights.mjs';
import { MonitoringService } from './src/monitoring-service-insights.mjs';
import { LibreNmsProvider } from './src/providers/librenms-provider-insights.mjs';
import { RrdSeriesProvider } from './src/providers/rrd-series-provider.mjs';
import { createSiteAgentServiceFromEnv } from './src/site-agent-config.mjs';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const port = parsePort(process.env.PORT || '4310');
const host = process.env.HOST || '127.0.0.1';
const rrdSeries = new RrdSeriesProvider({
  hostDir: process.env.LIBRENMS_RRD_HOST_DIR || resolve(packageRoot, '../../apps/librenms-docker/examples/compose/librenms/rrd'),
  containerDir: process.env.LIBRENMS_RRD_CONTAINER_DIR || '/data/rrd',
  container: process.env.LIBRENMS_RRD_CONTAINER || 'librenms'
});
const provider = new LibreNmsProvider({
  baseUrl: process.env.LIBRENMS_URL || 'http://127.0.0.1:8000',
  token: process.env.LIBRENMS_TOKEN || '',
  timeoutMs: Number(process.env.LIBRENMS_TIMEOUT_MS || 5000),
  rrdSeries
});
const service = new MonitoringService(provider, { seriesLimit: Number(process.env.SERIES_MAX_POINTS || 180) });
const siteAgentService = createSiteAgentServiceFromEnv();
const app = createApp({ service, siteAgentService, publicDir: resolve(packageRoot, 'public-next'), packageRoot });

createServer(app).listen(port, host, () => {
  console.log(`Monitoring dashboard: http://${host}:${port} (provider=${provider.descriptor.id}, configured=${provider.descriptor.configured}, siteAgent=${Boolean(siteAgentService)})`);
});

function parsePort(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('PORT must be between 1 and 65535');
  return number;
}
