import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureKernel, evaluateGuard, runTransition } from './index.mjs';
import { ROOT, prepareDirectories, runAndRecord, writeJSON } from './process.mjs';

await prepareDirectories();
const evidence = await mkdtemp(join(ROOT, 'check-'));
const checks = [];
const maximum = '18446744073709551615';
const good = {
  revision: '7', base_revision: '7', retained_ids: [0, 1, 2, 63],
  required_ids: [1, 63], keep_ids: [1, 63],
};
const cases = [
  ['legal compaction', good, true, '8', [1, 63]],
  ['lost required', { ...good, keep_ids: [1] }, false, '7', good.retained_ids],
  ['stale revision', { ...good, base_revision: '6' }, false, '7', good.retained_ids],
  ['unknown record', { ...good, keep_ids: [1, 3, 63] }, false, '7', good.retained_ids],
  ['revision overflow', { ...good, revision: maximum, base_revision: maximum }, false, maximum, good.retained_ids],
  ['last increment', { ...good, revision: '18446744073709551614', base_revision: '18446744073709551614' }, true, maximum, [1, 63]],
  ['empty state', { revision: '0', base_revision: '0', retained_ids: [], required_ids: [], keep_ids: [] }, true, '1', []],
  ['no caller precondition', { ...good, required_ids: [3], keep_ids: [1] }, false, '7', good.retained_ids],
  ['full u64 mask', { ...good, retained_ids: Array.from({ length: 64 }, (_, id) => id), required_ids: [63], keep_ids: [63] }, true, '8', [63]],
  ['bigint revisions', { ...good, revision: 7n, base_revision: 7n }, true, '8', [1, 63]],
];

async function testTransitions(label) {
  for (const [name, input, accepted, revision, retained] of cases) {
    const result = await runTransition(input);
    assert.equal(result.accepted, accepted, name);
    assert.equal(result.revision, revision, name);
    assert.deepEqual(result.retained_ids, retained, name);
    assert.equal(JSON.parse(result.stdout).accepted, result.accepted);
    assert.match(result.binary_sha256, /^[0-9a-f]{64}$/);
    checks.push({ name: `${label}: ${name}`, passed: true, native: result });
  }
}

try {
  const statuses = await Promise.all(Array.from({ length: 12 }, () => ensureKernel()));
  const initial = statuses[0];
  assert.equal(initial.ready, true, JSON.stringify(initial));
  for (const status of statuses) assert.deepEqual(status, initial, 'concurrent ensureKernel must return the same build');
  checks.push({ name: 'concurrent idempotent initialization (12 requests)', passed: true, status: initial });
  const workerCode = `import { ensureKernel } from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};
console.log(JSON.stringify(await ensureKernel()));`;
  const workers = await Promise.all(Array.from({ length: 4 }, (_, index) => runAndRecord(
    process.execPath, ['--input-type=module', '-e', workerCode], evidence, `ensure-worker-${index}`, 30_000,
  )));
  for (const worker of workers) {
    assert.equal(worker.exit_code, 0, worker.stderr);
    assert.deepEqual(JSON.parse(worker.stdout), initial, 'concurrent processes must reuse the active verified binary');
  }
  checks.push({ name: 'cross-process idempotence (4 concurrent Node processes)', passed: true });
  await testTransitions(initial.active_variant);

  const malformed = [
    { revision: '18446744073709551616' }, { revision: '-1' }, { revision: '+1' },
    { revision: '01' }, { revision: ' 1' }, { revision: '1.0' }, { revision: 1 },
    { revision: '1\n' }, { revision: '1\r' }, { revision: '\n1' },
    { revision: -1n }, { revision: 1n << 64n }, { base_revision: undefined },
    { keep_ids: [64] }, { keep_ids: [-1] }, { keep_ids: [1.5] },
    { keep_ids: ['1'] }, { keep_ids: [1, 1] }, { retained_ids: null },
    { required_ids: '2' }, { source: 'arbitrary code' },
  ];
  for (const patch of malformed) {
    await assert.rejects(runTransition({ ...good, ...patch }), /u64|decimal|ID|array|duplicate|unexpected/i);
  }
  checks.push({ name: `${malformed.length} malformed JS inputs rejected`, passed: true });
  for (const input of [
    { variant: 'original' }, { variant: '__proto__' }, { variant: 'reorder', activate: 'true' },
    { variant: 'reorder', source: 'arbitrary code' },
  ]) await assert.rejects(evaluateGuard(input), /variant|boolean|unexpected/);
  checks.push({ name: 'closed candidate interface (4 invalid requests)', passed: true });

  for (const [index, args] of [
    [], ['-1', '0', '0', '0', '0'], ['01', '0', '0', '0', '0'],
    ['0', '0', maximum + '0', '0', '0'], ['0', '0', '0', '+0', '0'],
  ].entries()) {
    const native = await runAndRecord(join(initial.artifact_dir, 'kernel-native'), args, evidence, `invalid-native-${index}`, 5_000);
    assert.equal(native.exit_code, 2);
    assert.equal(native.stdout, '');
    checks.push({ name: `native malformed input ${index}`, passed: true, native });
  }

  const before = await readFile(join(ROOT, 'active.json'), 'utf8');
  for (const variant of ['drop-required', 'drop-revision', 'reject-all']) {
    const result = await evaluateGuard({ variant, activate: true });
    assert.equal(result.success, false, variant);
    assert.ok(result.errors > 0, `${variant}: must be a real verifier rejection`);
    assert.equal(result.activated, false);
    assert.equal(result.binary_sha256, undefined);
    assert.equal(result.contract_sha256, initial.contract_sha256);
    assert.equal(await readFile(join(ROOT, 'active.json'), 'utf8'), before, 'failed candidate must leave pointer byte-identical');
    const { source, ...summary } = result;
    checks.push({ name: `${variant} verifier negative control`, passed: true, evaluation: summary });
  }

  const preview = await evaluateGuard({ variant: 'reorder', activate: false });
  assert.equal(preview.success, true, preview.stderr);
  assert.equal(preview.verified, true);
  assert.equal(preview.verified_count, 1);
  assert.equal(preview.errors, 0);
  assert.equal(preview.activated, false);
  assert.equal(preview.contract_sha256, initial.contract_sha256);
  assert.equal(await readFile(join(ROOT, 'active.json'), 'utf8'), before, 'preview must leave pointer byte-identical');
  const { source: previewSource, ...previewSummary } = preview;
  checks.push({ name: 'reorder verifies without activation', passed: true, evaluation: previewSummary });

  const repaired = await evaluateGuard({ variant: 'reorder', activate: true });
  assert.equal(repaired.success, true, repaired.stderr);
  assert.equal(repaired.activated, true);
  assert.equal(repaired.contract_sha256, initial.contract_sha256);
  const active = await ensureKernel();
  assert.equal(active.active_variant, 'reorder');
  assert.equal(active.binary_sha256, repaired.binary_sha256);
  assert.equal(active.artifact_dir, repaired.artifact_dir);
  const { source: repairedSource, ...repairedSummary } = repaired;
  checks.push({ name: 'verified reorder activation', passed: true, evaluation: repairedSummary });
  await testTransitions('activated reorder');

  await writeJSON(join(evidence, 'summary.json'), { success: true, checks, active });
  console.log(JSON.stringify({ success: true, checks: checks.length, evidence_dir: evidence, active }, null, 2));
} catch (error) {
  await writeJSON(join(evidence, 'summary.json'), { success: false, checks, error: error.stack });
  console.error(JSON.stringify({ success: false, checks: checks.length, evidence_dir: evidence, error: error.stack }, null, 2));
  process.exitCode = 1;
}
