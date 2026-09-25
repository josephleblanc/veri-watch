import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveError, optionsFromArgs } from '../experiments/run.mjs';
import { modelExchangeCounts } from '../experiments/artifacts.mjs';

test('harness is bounded and live mode is explicitly opt-in', () => {
  assert.equal(optionsFromArgs([]).live, 0);
  assert.deepEqual(optionsFromArgs(['--seed=17', '--cases=25', '--stress=50', '--live=6']), {
    seed: 17, cases: 25, stress: 50, live: 6,
  });
  for (const args of [['--cases=10000'], ['--stress=10000'], ['--live=13'], ['--live=-1'], ['--seed=4294967296'], ['--live='], ['--unknown']]) {
    assert.throws(() => optionsFromArgs(args));
  }
});

test('transport and malformed live errors remain distinguishable from missing credentials', () => {
  assert.equal(classifyLiveError(new TypeError('fetch failed')), 'transport');
  assert.equal(classifyLiveError(new Error('HTTP 503')), 'transport');
  assert.equal(classifyLiveError(new SyntaxError('Unexpected token in JSON')), 'malformed');
  assert.equal(classifyLiveError(new Error('Invalid proposal keep_ids')), 'malformed');
  assert.equal(classifyLiveError(new Error('Missing API key')), 'unavailable');
  assert.equal(classifyLiveError(new Error('Uncategorized provider failure')), 'operation_error');
});

test('live accounting counts wire attempts/responses, excluding provider health checks', () => {
  // Unit-only constructed exchanges test bookkeeping, never model reliability.
  const counts = modelExchangeCounts({ unit_case: { provider: 'liquid', exchanges: [
    { request: { url: '/api/tags' }, response_raw: '{}' },
    { request: { body: { model: 'example' } }, response_raw: '{}' },
    { request: { body: { messages: [] } }, error: 'network failure' },
    { request: { body: { messages: [] } }, response_raw: 'malformed actual response shape' },
  ] } });
  assert.deepEqual(counts, { requests: 2, responses: 1 });
});
