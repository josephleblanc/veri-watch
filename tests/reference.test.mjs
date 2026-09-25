import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCases, referenceTransition, stressActions, U64_MAX } from '../experiments/reference.mjs';

test('oracle boundary anchors distinguish accept-all, reject-all, lossy and rounded revisions', () => {
  const anchors = nativeCases();
  const named = name => anchors.find(item => item.name === name).expected;
  assert.deepEqual(named('useful-compaction'), { accepted: true, revision: '8', retained_ids: [0, 63] });
  assert.deepEqual(named('last-increment'), { accepted: true, revision: String(U64_MAX), retained_ids: [63] });
  assert.equal(named('exact-above-js-safe-integer').revision, '9007199254740994');
  for (const name of ['required-loss', 'stale', 'unknown-record', 'overflow', 'nearby-high-revisions-are-not-equal', 'required-outside-retained']) {
    const item = anchors.find(candidate => candidate.name === name);
    assert.deepEqual(item.expected, { accepted: false, revision: item.input.revision, retained_ids: item.input.retained_ids });
  }
  assert.deepEqual(named('empty-state'), { accepted: true, revision: '1', retained_ids: [] });
});

test('seeded matrix is reproducible, varied, bounded, and covers every rejection category', () => {
  assert.deepEqual(nativeCases({ seed: 17 }), nativeCases({ seed: 17 }));
  assert.notDeepEqual(nativeCases({ seed: 17 }), nativeCases({ seed: 18 }));
  assert.equal(nativeCases().length, 48);
  assert.deepEqual(stressActions({ seed: 17 }), stressActions({ seed: 17 }));
  for (const count of [25, 60]) {
    const cases = nativeCases({ count });
    for (const category of ['legal', 'required-loss', 'stale', 'unknown-record', 'overflow']) {
      assert.ok(cases.some(item => item.category === category));
    }
    for (const { input, expected } of cases) {
      assert.ok(BigInt(input.revision) >= 0n && BigInt(input.revision) <= U64_MAX);
      for (const key of ['retained_ids', 'required_ids', 'keep_ids']) {
        assert.ok(input[key].every(id => Number.isInteger(id) && id >= 0 && id < 64));
      }
      assert.deepEqual(referenceTransition(input), expected);
    }
  }
  assert.throws(() => nativeCases({ count: 1000 }), /25\.\.60/);
  assert.throws(() => stressActions({ count: 1000 }), /50\.\.100/);
});
