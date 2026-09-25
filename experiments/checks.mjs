import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { referenceTransition, sortedIds } from './reference.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function checkTransition(actual, input, expected = referenceTransition(input)) {
  assert.equal(typeof actual.revision, 'string', 'revision must remain an exact decimal string');
  assert.equal(actual.accepted, expected.accepted, 'acceptance must match the independent set oracle');
  assert.equal(actual.revision, expected.revision, 'revision must increment exactly, or remain unchanged on rejection');
  assert.deepEqual(sortedIds(actual.retained_ids), expected.retained_ids, 'retained set must match the set oracle');
  assert.equal(actual.retained_ids.length, new Set(actual.retained_ids).size, 'IDs must be unique');
  assert.ok(Number.isFinite(actual.duration_ms) && actual.duration_ms >= 0, 'native duration must be measured');
  assert.equal(typeof actual.stdout, 'string', 'retain raw native stdout');
  assert.match(actual.binary_sha256, /^[a-f0-9]{64}$/, 'identify the binary actually executed');
}

export function checkMutation(result, variant, contractHash) {
  const shouldVerify = variant === 'reorder';
  assert.equal(result.variant, variant);
  assert.equal(result.activated, false, 'experiment must never activate a candidate');
  assert.equal(result.verified, shouldVerify, `${variant}: unexpected proof result`);
  assert.equal(result.success, shouldVerify, `${variant}: unexpected build result`);
  if (shouldVerify) assert.equal(result.errors, 0, 'positive control must have zero verifier errors');
  else assert.ok(Number.isInteger(result.errors) && result.errors > 0,
    'negative control must fail proof obligations, not merely fail to launch the verifier');
  assert.equal(result.contract_sha256, contractHash, 'every mutation must use the SAME fixed contract');
  assert.match(result.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(result.source), result.source_sha256, 'digest must identify the candidate source');
  assert.ok(Number.isFinite(result.duration_ms) && result.duration_ms >= 0);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.ok(result.stdout.length + result.stderr.length > 0, 'retain real verifier output');
  assert.equal(typeof result.artifact_dir, 'string');
  if (shouldVerify) assert.match(result.binary_sha256, /^[a-f0-9]{64}$/);
}

export function activeIdentity(status) {
  return Object.fromEntries(['active_variant', 'source_sha256', 'contract_sha256', 'binary_sha256']
    .map(key => [key, status[key]]));
}

export function checkSnapshotCounts(snapshot) {
  assert.equal(typeof snapshot.revision, 'string');
  const retained = new Set(snapshot.retained_ids);
  const required = new Set(snapshot.required_ids);
  const records = new Map(snapshot.records.map(record => [record.id, record]));
  assert.equal(records.size, snapshot.records.length, 'record IDs must be immutable unique identities');
  assert.ok([...retained].every(id => records.has(id)), 'retained IDs must identify actual records');
  assert.deepEqual(sortedIds(snapshot.records.filter(record => record.required).map(record => record.id)), sortedIds(required));
  assert.equal(snapshot.metrics.retained_count, retained.size);
  assert.equal(snapshot.metrics.required_count, required.size);
  assert.equal(snapshot.metrics.missing_required, [...required].filter(id => !retained.has(id)).length);
  const transitions = snapshot.events.filter(event => typeof event.accepted === 'boolean');
  assert.equal(snapshot.metrics.steps, snapshot.events.length, 'steps must count recorded events, not a planned schedule');
  assert.equal(snapshot.metrics.accepted, transitions.filter(event => event.accepted).length);
  assert.equal(snapshot.metrics.rejected, transitions.filter(event => !event.accepted).length);
  const losesRequired = event => [...required].some(id => !event.baseline_ids.includes(id));
  assert.equal(snapshot.metrics.unsafe_baseline, transitions.filter(losesRequired).length,
    'unsafe baseline count must come from actual same-snapshot proposals');
  assert.equal(snapshot.metrics.protected_rejections, transitions.filter(event => !event.accepted && losesRequired(event)).length);
  assert.equal(snapshot.metrics.model_calls, snapshot.events.filter(event => event.origin === 'live_model').length,
    'only fresh sponsor requests count as model calls');
  assert.ok(Number.isInteger(snapshot.metrics.context_bytes) && snapshot.metrics.context_bytes >= 0);
  return transitions;
}

export function checkEngineTransition(before, after, expectedOrigin) {
  checkSnapshotCounts(after);
  assert.equal(after.events.length, before.events.length + 1, 'one action must append one event');
  const event = after.events.at(-1);
  assert.equal(event.origin, expectedOrigin);
  assert.equal(event.before.revision, before.revision);
  assert.deepEqual(sortedIds(event.before.retained_ids), sortedIds(before.retained_ids), 'baseline and gate must start from this same snapshot');
  const input = {
    revision: before.revision,
    base_revision: event.proposal.base_revision,
    retained_ids: before.retained_ids,
    required_ids: before.required_ids,
    keep_ids: event.proposal.keep_ids,
  };
  const expected = referenceTransition(input);
  assert.equal(event.accepted, expected.accepted);
  assert.equal(after.revision, expected.revision);
  assert.deepEqual(sortedIds(after.retained_ids), expected.retained_ids);
  assert.equal(event.after.revision, after.revision);
  assert.deepEqual(sortedIds(event.after.retained_ids), sortedIds(after.retained_ids));
  assert.deepEqual(sortedIds(event.baseline_ids), sortedIds(event.proposal.keep_ids), 'ungated baseline must apply the identical proposal');
  assert.deepEqual(sortedIds(after.baseline_ids), sortedIds(event.baseline_ids));
  assert.equal(event.bytes_before, before.metrics.context_bytes);
  assert.equal(event.bytes_after, after.metrics.context_bytes);
  assert.equal(after.metrics.initial_bytes, before.metrics.initial_bytes, 'initial bytes is a fixed per-run denominator');
  assert.equal(after.metrics.verifications, before.metrics.verifications, 'runtime transitions must not be counted as proof-verification events');
  assert.deepEqual(after.records, before.records, 'compaction changes retention, not immutable record text');
  return event;
}

export function stringsIn(value, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap(child => stringsIn(child, seen));
}

export function promptStrings(evidence) {
  const prompts = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/prompt/i.test(key) || key === 'messages') prompts.push(...stringsIn(child));
      else visit(child);
    }
  };
  visit(evidence);
  return prompts;
}
