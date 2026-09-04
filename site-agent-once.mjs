import { loadSiteAgentClientConfig, runSiteAgentOnce } from './src/site-agent-client.mjs';

try {
  const result = await runSiteAgentOnce(loadSiteAgentClientConfig());
  process.stdout.write(`${JSON.stringify({ status: 'ok', ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'error', message: error?.message || 'Site Agent failed' })}\n`);
  process.exitCode = 1;
}
