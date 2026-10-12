const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

export function loadUplinkIdentityConfig(env = process.env) {
  const edgeId = env.SITE_AGENT_EDGE_ID;
  if (
    typeof edgeId !== 'string'
    || edgeId.length < 1
    || edgeId.length > 128
    || edgeId !== edgeId.trim()
    || controlCharacters.test(edgeId)
  ) {
    throw new TypeError('SITE_AGENT_EDGE_ID must contain an opaque Center-issued identity of 1 to 128 characters');
  }
  return { edgeId };
}
