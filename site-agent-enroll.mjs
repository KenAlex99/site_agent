import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';
import { createSiteAgentCenterJsonClient } from './src/site-agent-center-json-client.mjs';
import { loadSiteAgentCenterTarget } from './src/site-agent-center-target.mjs';
import { enrollSiteAgent } from './src/site-agent-enrollment.mjs';
import { createSiteAgentIdentityStore } from './src/site-agent-identity-store.mjs';

try {
  const target = loadSiteAgentCenterTarget();
  const directory = resolve(process.env.SITE_AGENT_STATE_DIR || '/var/lib/site-agent');
  const store = await createSiteAgentIdentityStore({ directory });
  const code = await readHiddenCode();
  const result = await enrollSiteAgent({
    client: createSiteAgentCenterJsonClient({ target }),
    store,
    enrollmentCode: code,
    centerOrigin: target.origin
  });
  process.stdout.write(`${JSON.stringify({ status: 'registered', ...result })}\n`);
} catch {
  process.stderr.write('Enrollment did not complete. Inspect the local recovery state and Center registration status.\n');
  process.exitCode = 1;
}

function readHiddenCode() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('interactive terminal required');
  return new Promise((resolveCode, reject) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('Enrollment code (input hidden): ');
    let value = '';
    const finish = (error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw || false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolveCode(value);
    };
    const onKeypress = (input, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('cancelled'));
      if (key.name === 'return' || key.name === 'enter') {
        if (value.length < 32 || value.length > 512) return finish(new Error('invalid input'));
        return finish();
      }
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (typeof input === 'string' && !/[\u0000-\u001f\u007f]/u.test(input) && value.length + input.length <= 512) value += input;
    };
    process.stdin.on('keypress', onKeypress);
  });
}
