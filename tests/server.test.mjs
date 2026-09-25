import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createEngine } from '../lib/engine.mjs';
import { createArtifacts } from '../experiments/artifacts.mjs';

test('HTTP dashboard uses the native engine and exports exact evidence; malformed requests cannot mutate state', async t => {
  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Provider network disabled in HTTP tests'); });
  const artifacts = await createArtifacts('http-test');
  const engine = createEngine({ evidenceRoot: join(artifacts.directory, 'engine') });
  const { server, ready } = createApp(engine);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => localFetch(base + path);
  const post = (body, headers = {}) => localFetch(base + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  });

  const initial = await (await get('/api/state')).json();
  assert.equal(initial.metrics.steps, 0);
  assert.equal(initial.kernel.verified, true);
  const html = await get('/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /src="\/app.js"/);
  const controller = await get('/app.js');
  assert.match(controller.headers.get('content-type'), /javascript/);
  assert.match(await controller.text(), /api\/action/);

  const safeResponse = await post(JSON.stringify({ action: 'safe' }));
  assert.equal(safeResponse.status, 200);
  const safe = await safeResponse.json();
  assert.equal(safe.events.at(-1).accepted, true);
  assert.ok(safe.metrics.context_bytes < initial.metrics.context_bytes);
  const evidence = await (await get(`/api/evidence/${safe.events.at(-1).id}`)).json();
  assert.equal(evidence.native.accepted, true);
  assert.equal(evidence.native.revision, safe.revision);
  assert.match(evidence.native.binary_sha256, /^[0-9a-f]{64}$/);
  for (const record of initial.records.filter(record => record.required)) assert.ok(evidence.prompt_after.includes(record.text));
  const exported = await get('/api/export');
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const run = await exported.json();
  assert.equal(run.run_id, safe.run_id);
  assert.deepEqual(run.evidence[0], evidence);

  assert.equal((await post('{broken')).status, 400);
  assert.equal((await post(JSON.stringify({ action: 'reset' }), { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await get('/api/evidence/unknown-event')).status, 404);
  assert.equal((await get('/.env')).status, 404);
  const after = await (await get('/api/state')).json();
  assert.equal(after.revision, safe.revision);
  assert.equal(after.events.length, 1);
  assert.deepEqual(after.retained_ids, safe.retained_ids);
  await artifacts.write('http-result.json', { initial, safe, evidence, after, passed: true });
});
