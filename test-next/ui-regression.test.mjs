import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const publicRoot = new URL('../public-next/', import.meta.url);

test('insights page uses a light theme and data-driven charts instead of graph images', async () => {
  const [html, script, css, renderer] = await Promise.all([
    readFile(new URL('insights.html', publicRoot), 'utf8'),
    readFile(new URL('insights.js', publicRoot), 'utf8'),
    readFile(new URL('insights.css', publicRoot), 'utf8'),
    readFile(new URL('renderers/uplot-renderer.js', publicRoot), 'utf8')
  ]);
  assert.match(html, /color-scheme" content="light"/);
  assert.match(css, /High-contrast daylight operations theme/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(script, /renderImage|\/graphs\//);
  assert.match(script, /\/series\?/);
  assert.match(renderer, /formatTimestamp/);
  assert.match(renderer, /legend: \{ show: true, live: true \}/);
});

test('browser pages use the shared request ID helper instead of calling randomUUID directly', async () => {
  const [app, insights] = await Promise.all([
    readFile(new URL('app.js', publicRoot), 'utf8'),
    readFile(new URL('insights.js', publicRoot), 'utf8')
  ]);
  for (const script of [app, insights]) {
    assert.match(script, /createRequestId/);
    assert.doesNotMatch(script, /crypto\.randomUUID\s*\(/);
  }
});
