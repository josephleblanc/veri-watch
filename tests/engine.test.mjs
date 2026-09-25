import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createArtifacts, treeHashes } from '../experiments/artifacts.mjs';
import { checkEngineTransition, checkSnapshotCounts, promptStrings, sha256 } from '../experiments/checks.mjs';

const engineUrl = new URL('../lib/engine.mjs', import.meta.url);
const kernelUrl = new URL('../kernel/index.mjs', import.meta.url);
let available = true;
try { await Promise.all([access(engineUrl), access(kernelUrl)]); } catch { available = false; }

test('engine counts real events, pairs the same snapshot, preserves commitments and prior evidence', {
  skip: available ? false : 'engine/kernel modules have not landed; engine checks NOT RUN',
  timeout: 180_000,
}, async t => {
  // Even a developer shell containing sponsor credentials cannot make test requests.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network disabled in deterministic engine tests'); });
  const artifacts = await createArtifacts('engine-test');
  const evidenceRoot = join(artifacts.directory, 'engine');
  const { createEngine } = await import(engineUrl);
  const engine = await createEngine({ evidenceRoot });
  await engine.init();
  let before = await engine.snapshot();
  checkSnapshotCounts(before);
  assert.equal(before.metrics.model_calls, 0);
  assert.equal(before.metrics.initial_bytes, before.metrics.context_bytes);
  assert.ok(before.required_ids.length > 0, 'scenario needs an actual commitment');
  assert.ok(before.retained_ids.length > before.required_ids.length, 'scenario needs a removable observation');
  const originalRun = before.run_id;
  const originalRequired = before.records.filter(record => record.required);
  const actions = ['drop-required', 'safe', 'stale', 'safe'];
  for (const action of actions) {
    await t.test(action, async () => {
      await engine.act({ action });
      const after = await engine.snapshot();
      const event = checkEngineTransition(before, after, action === 'safe' ? 'deterministic_scenario' : 'injected_fault');
      assert.equal(event.accepted, action === 'safe');
      assert.equal(after.metrics.model_calls, 0, 'injected events are not live model requests');
      if (action === 'drop-required') {
        assert.ok(event.violated_ids.length > 0);
        assert.ok(after.required_ids.some(id => !event.baseline_ids.includes(id)));
        assert.equal(after.metrics.unsafe_baseline, 1);
        assert.equal(after.metrics.protected_rejections, 1);
      }
      if (action === 'safe' && before.retained_ids.length > before.required_ids.length) {
        assert.ok(after.retained_ids.length < before.retained_ids.length, 'positive case must usefully compact');
        assert.ok(after.metrics.context_bytes < before.metrics.context_bytes);
      }
      const evidence = await engine.evidence(event.id);
      assert.ok(evidence && typeof evidence === 'object', 'each transition must expose inspectable evidence');
      await artifacts.outcome({ action, before, after, evidence });
      before = after;
    });
  }

  await t.test('prompt evidence contains the exact mandatory record text', async () => {
    const evidence = await engine.evidence(before.events.at(-1).id);
    const prompts = promptStrings(evidence);
    assert.ok(prompts.length > 0, 'evidence must expose an actual next prompt/messages, not just record metadata');
    for (const record of originalRequired) {
      assert.ok(prompts.some(prompt => prompt.includes(record.text)), `prompt lost or rewrote required record ${record.id}`);
    }
  });

  await t.test('manual unknown-record proposal is rejected without changing records', async () => {
    const unknown = Array.from({ length: 64 }, (_, id) => id).find(id => !before.retained_ids.includes(id));
    assert.notEqual(unknown, undefined);
    await engine.act({ action: 'compact', base_revision: before.revision, keep_ids: [...before.required_ids, unknown] });
    const after = await engine.snapshot();
    const event = after.events.at(-1);
    assert.equal(event.accepted, false);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.retained_ids, before.retained_ids);
    assert.deepEqual(after.records, before.records);
    checkSnapshotCounts(after);
    await artifacts.outcome({ action: 'compact-unknown', before, after, evidence: await engine.evidence(event.id) });
    before = after;
  });

  await t.test('simultaneous proposals serialize against the current revision', async () => {
    const request = { action: 'compact', base_revision: before.revision, keep_ids: [...before.required_ids] };
    await Promise.all([engine.act(structuredClone(request)), engine.act(structuredClone(request))]);
    const after = await engine.snapshot();
    const events = after.events.slice(before.events.length);
    assert.equal(events.length, 2);
    assert.equal(events[0].accepted, true);
    assert.equal(events[1].accepted, false, 'the second same-base proposal must become stale');
    assert.deepEqual(events[0].before, { revision: before.revision, retained_ids: before.retained_ids });
    assert.deepEqual(events[1].before, events[0].after);
    assert.equal(after.revision, String(BigInt(before.revision) + 1n));
    checkSnapshotCounts(after);
    await artifacts.outcome({ action: 'concurrent-compactions', request, before, after,
      evidence: await Promise.all(events.map(event => engine.evidence(event.id))) });
    before = after;
  });

  await t.test('reset uses a fresh run and preserves every prior evidence file byte-for-byte', async () => {
    const previous = await treeHashes(evidenceRoot);
    assert.ok(Object.keys(previous).length > 0, 'real engine evidence must have reached disk');
    await artifacts.write('before-reset-export.json', await engine.exportRun());
    await engine.act({ action: 'reset' });
    const after = await engine.snapshot();
    assert.notEqual(after.run_id, originalRun);
    assert.equal(after.metrics.model_calls, 0);
    checkSnapshotCounts(after);
    for (const [path, hash] of Object.entries(previous)) {
      assert.equal(sha256(await readFile(join(evidenceRoot, path))), hash, `reset removed or rewrote prior evidence: ${path}`);
    }
    await artifacts.write('after-reset-export.json', await engine.exportRun());
  });
});
