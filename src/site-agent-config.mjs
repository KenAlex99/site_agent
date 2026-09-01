import { SiteAgentService } from './site-agent-service.mjs';
import { InMemorySiteAgentStore } from './site-agent-store.mjs';

export function createSiteAgentServiceFromEnv(env = process.env) {
  const agentValue = env.SITE_AGENT_CREDENTIALS_JSON;
  const viewerValue = env.PLATFORM_VIEWER_CREDENTIALS_JSON;
  if (!agentValue && !viewerValue) return null;
  if (!agentValue || !viewerValue) throw new Error('SITE_AGENT_CREDENTIALS_JSON and PLATFORM_VIEWER_CREDENTIALS_JSON must be configured together');
  return new SiteAgentService({
    store: new InMemorySiteAgentStore(),
    agentCredentials: parseArray(agentValue, 'SITE_AGENT_CREDENTIALS_JSON'),
    viewerCredentials: parseArray(viewerValue, 'PLATFORM_VIEWER_CREDENTIALS_JSON')
  });
}

function parseArray(value, name) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${name} must contain valid JSON`); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${name} must contain a non-empty JSON array`);
  return parsed;
}
