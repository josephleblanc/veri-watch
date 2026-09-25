import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { nativeCases } from '../experiments/reference.mjs';
import { activeIdentity, checkMutation, checkTransition } from '../experiments/checks.mjs';

const kernelUrl = new URL('../kernel/index.mjs', import.meta.url);
let available = true;
try { await access(kernelUrl); } catch { available = false; }

test('native transitions match an independent set oracle (48 bounded cases)', {
  skip: available ? false : 'kernel/index.mjs has not landed; native checks NOT RUN',
  timeout: 180_000,
}, async t => {
  const { ensureKernel, runTransition } = await import(kernelUrl);
  const status = await ensureKernel();
  assert.equal(status.ready, true, JSON.stringify(status));
  assert.equal(status.verified, true, 'native checks must execute a verified binary');
  let accepted = 0;
  let rejected = 0;
  for (const item of nativeCases()) {
    await t.test(item.name, async () => {
      const original = structuredClone(item.input);
      const result = await runTransition(item.input);
      checkTransition(result, item.input, item.expected);
      assert.deepEqual(item.input, original, 'caller input must not be mutated');
      assert.equal(result.binary_sha256, status.binary_sha256);
      result.accepted ? accepted++ : rejected++;
    });
  }
  assert.ok(accepted > 0 && rejected > 0, 'both useful acceptance and rejection must actually run');
});

test('fixed-contract proof mutations fail except reorder; active kernel is preserved', {
  skip: available ? false : 'kernel/index.mjs has not landed; proof controls NOT RUN',
  timeout: 240_000,
}, async t => {
  const { ensureKernel, evaluateGuard } = await import(kernelUrl);
  const before = await ensureKernel();
  assert.equal(before.ready, true, JSON.stringify(before));
  assert.match(before.contract_sha256, /^[a-f0-9]{64}$/);
  for (const variant of ['drop-required', 'reject-all', 'drop-revision', 'reorder']) {
    await t.test(variant, async () => {
      const result = await evaluateGuard({ variant, activate: false });
      checkMutation(result, variant, before.contract_sha256);
      assert.deepEqual(activeIdentity(await ensureKernel()), activeIdentity(before));
    });
  }
});
