import { requireIdentifier } from './contracts.mjs';
import { BearerIdentityRegistry } from './site-agent-auth.mjs';
import { normalizeSiteAgentBatch } from './site-agent-contracts.mjs';

export class SiteAgentService {
  constructor({ store, agentCredentials = [], viewerCredentials = [], clock = () => Date.now() }) {
    if (!store) throw new TypeError('site agent store is required');
    this.store = store;
    this.clock = clock;
    this.agents = new BearerIdentityRegistry(agentCredentials, { role: 'agent' });
    this.viewers = new BearerIdentityRegistry(viewerCredentials, { role: 'viewer' });
  }

  ingest(authorization, input) {
    const identity = this.agents.authenticate(authorization);
    const batch = normalizeSiteAgentBatch(input, identity, { now: this.clock() });
    return this.store.ingest(identity, batch);
  }

  listSources(authorization) {
    const viewer = this.viewers.authenticate(authorization);
    return { items: this.store.listSources(viewer.tenantIds) };
  }

  snapshot(authorization, sourceId) {
    const viewer = this.viewers.authenticate(authorization);
    return this.store.snapshot(requireIdentifier(sourceId, 'sourceId'), viewer.tenantIds);
  }
}
