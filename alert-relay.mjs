import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadAlertRelayConfig } from './src/alert-relay-config.mjs';
import { AtomicAlertFileQueue } from './src/alert-file-queue.mjs';
import { AlertCloudClient } from './src/alert-cloud-client.mjs';
import { AlertQueueWorker } from './src/alert-queue-worker.mjs';
import { AlertRelayService } from './src/alert-relay-service.mjs';

const config = loadAlertRelayConfig();
const [localToken, cloudToken] = await Promise.all([
  secret(config.localTokenFile), secret(config.cloudTokenFile)
]);
const queue = new AtomicAlertFileQueue({
  rootDir: config.queueDir, maxEntries: config.maxEntries, maxBytes: config.maxBytes
});
await queue.init();
const client = new AlertCloudClient({
  baseUrl: config.cloudUrl, token: cloudToken, timeoutMs: config.cloudTimeoutMs
});
const worker = new AlertQueueWorker({ queue, client });
const relay = new AlertRelayService({
  localToken, queue, worker, alertmanagerUrl: config.alertmanagerUrl,
  snapshotIntervalMs: config.snapshotIntervalMs, workerIntervalMs: config.workerIntervalMs
});
const server = createServer(relay.handler());

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, resolve);
});
relay.start();
console.log(`Alert relay listening on http://${config.host}:${config.port}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Alert relay received ${signal}; stopping`);
  await relay.stop();
  await new Promise((resolve) => server.close(resolve));
}

process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0), () => process.exit(1)));
process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0), () => process.exit(1)));

async function secret(path) {
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length < 16 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error(`Secret file is invalid: ${path}`);
  return value;
}
