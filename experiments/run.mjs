#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArtifacts, errorRecord, modelExchangeCounts, providerEvidence, relativeArtifact, sourceIdentities, treeHashes } from './artifacts.mjs';
import { activeIdentity, checkEngineTransition, checkMutation, checkSnapshotCounts, checkTransition, promptStrings } from './checks.mjs';
import { DEFAULT_SEED, nativeCases, stressActions } from './reference.mjs';

const usage = `Usage: node experiments/run.mjs [--seed=N] [--cases=48] [--stress=64] [--live=0]

  --seed=N      Unsigned 32-bit seed (decimal or 0x-prefixed).
  --cases=N     25..60 independent native differential cases (default 48).
  --stress=N    50..100 deterministic engine transitions (default 64).
  --live=N      0..12 fresh sponsor requests; opt-in only (default 0).
  --help        Print this help without initializing modules or providers.

Fresh evidence: target/tmp/experiments/<timestamp>-run-<unique>/
Exit status: 0 all requested checks passed; 1 a check failed; 2 modules unavailable.
Mutation candidates are ALWAYS evaluated with activate:false.
`;

export function optionsFromArgs(args) {
  const { values } = parseArgs({ args, options: {
    seed: { type: 'string', default: String(DEFAULT_SEED) },
    cases: { type: 'string', default: '48' },
    stress: { type: 'string', default: '64' },
    live: { type: 'string', default: '0' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) return { help: true };
  const options = Object.fromEntries(['seed', 'cases', 'stress', 'live'].map(key => [key, Number(values[key])]));
  for (const [key, min, max] of [['seed', 0, 0xffffffff], ['cases', 25, 60], ['stress', 50, 100], ['live', 0, 12]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max || values[key].trim() === '') {
      throw new RangeError(`--${key} must be an integer in ${min}..${max}`);
    }
  }
  return options;
}

// This classification is retained alongside raw errors; it is not a reliability score.
export function classifyLiveError(error) {
  const text = `${error?.code ?? ''} ${error?.name ?? ''} ${error?.message ?? error}`;
  if (/missing|not configured|credential|api.?key|unavailable|not ready/i.test(text)) return 'unavailable';
  if (/malformed|invalid.{0,30}(json|proposal|keep_ids|base_revision)|json|parse|syntax/i.test(text)) return 'malformed';
  if (/fetch|transport|network|timeout|timed out|abort|ECONN|ENOTFOUND|HTTP\s*[45]\d\d|status\s*[45]\d\d/i.test(text)) return 'transport';
  return 'operation_error';
}

async function importIfPresent(path) {
  const url = new URL(path, import.meta.url);
  try { await access(url); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return import(url);
}

export async function runExperiment(options) {
  const artifacts = await createArtifacts('run');
  const started = new Date().toISOString();
  const manifest = {
    schema: 'veri-watch-experiment-v1', started_at: started, options,
    origin: 'deterministic_scenario', live_opt_in: options.live > 0,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    protocol: 'experiments/PROTOCOL.md', identities: await sourceIdentities(),
    kernel: null, mutations: [], evidence_directory: relativeArtifact(artifacts.directory),
  };
  const summary = {
    schema: manifest.schema, status: 'running', seed: options.seed,
    native: { requested: options.cases, attempted: 0, accepted: 0, rejected: 0, passed: 0, failed: 0 },
    mutations: { requested: 4, attempted: 0, expected_proof_failures: 0, verified_reorders: 0, passed: 0, failed: 0 },
    stress: { requested: options.stress, attempted: 0, accepted: 0, rejected: 0, passed: 0, failed: 0 },
    live: { requested: options.live, attempted: 0, wire_requests: 0, wire_responses: 0, completed: 0, accepted: 0, rejected: 0, transport: 0, malformed: 0, unavailable: 0, operation_error: 0, validation_failures: 0 },
    checks: { passed: 0, failed: 0 }, unavailable: [], failures: [], artifacts: relativeArtifact(artifacts.directory),
  };
  const observed = async (suite, name, operation, verify, details = {}) => {
    let result;
    let failure = null;
    let phase = 'operation';
    try { result = await operation(); phase = 'validation'; await verify(result); }
    catch (error) { failure = errorRecord(error); }
    const outcome = { suite, name, ...details, passed: !failure, result: result ?? null, error: failure, failure_phase: failure ? phase : null };
    await artifacts.outcome(outcome);
    summary.checks[failure ? 'failed' : 'passed']++;
    if (failure) summary.failures.push({ suite, name, phase, error: failure });
    return outcome;
  };
  await artifacts.write('manifest.json', manifest);
  const fetchOriginal = globalThis.fetch;
  if (!options.live) globalThis.fetch = async () => { throw new Error('Network disabled: rerun with --live=N to opt in'); };
  try {
    const kernel = await importIfPresent('../kernel/index.mjs');
    if (!kernel) summary.unavailable.push('kernel/index.mjs is absent; native and proof checks not run');
    else {
      const startup = await observed('kernel', 'verified-startup', () => kernel.ensureKernel(), status => {
        assert.equal(status.ready, true, JSON.stringify(status));
        assert.equal(status.verified, true);
        for (const key of ['source_sha256', 'contract_sha256', 'binary_sha256']) assert.match(status[key], /^[a-f0-9]{64}$/);
        assert.ok(status.verus_version, 'manifest must identify Verus');
      });
      manifest.kernel = startup.result;
      if (manifest.kernel?.contract_sha256) manifest.kernel.spec_sha256 = manifest.kernel.contract_sha256;
      if (startup.passed) {
        for (const item of nativeCases({ seed: options.seed, count: options.cases })) {
          summary.native.attempted++;
          const outcome = await observed('native', item.name,
            () => kernel.runTransition(structuredClone(item.input)), actual => {
              checkTransition(actual, item.input, item.expected);
              assert.equal(actual.binary_sha256, manifest.kernel.binary_sha256);
            }, item);
          summary.native[outcome.passed ? 'passed' : 'failed']++;
          if (typeof outcome.result?.accepted === 'boolean') summary.native[outcome.result.accepted ? 'accepted' : 'rejected']++;
        }
        for (const variant of ['drop-required', 'reject-all', 'drop-revision', 'reorder']) {
          summary.mutations.attempted++;
          const outcome = await observed('mutation', variant,
            () => kernel.evaluateGuard({ variant, activate: false }), async result => {
              checkMutation(result, variant, manifest.kernel.contract_sha256);
              assert.deepEqual(activeIdentity(await kernel.ensureKernel()), activeIdentity(manifest.kernel), 'active kernel must not change');
            }, { origin: 'injected_fault', activate: false });
          summary.mutations[outcome.passed ? 'passed' : 'failed']++;
          if (outcome.passed) summary.mutations[variant === 'reorder' ? 'verified_reorders' : 'expected_proof_failures']++;
          if (outcome.result) manifest.mutations.push(Object.fromEntries(
            ['variant', 'source_sha256', 'contract_sha256', 'binary_sha256', 'artifact_dir', 'verified', 'activated']
              .map(key => [key, outcome.result[key] ?? null])));
        }
      }
    }

    const engineModule = await importIfPresent('../lib/engine.mjs');
    if (!engineModule) summary.unavailable.push('lib/engine.mjs is absent; stress, prompt, reset, and requested live checks not run');
    else if (!manifest.kernel?.ready) summary.unavailable.push('Native kernel unavailable; engine checks not run');
    else {
      const evidenceRoot = join(artifacts.directory, 'engine');
      const engine = await engineModule.createEngine({ evidenceRoot });
      const startup = await observed('engine', 'initial-snapshot', async () => {
        await engine.init();
        return engine.snapshot();
      }, snapshot => {
        checkSnapshotCounts(snapshot);
        assert.equal(snapshot.metrics.model_calls, 0);
        assert.ok(snapshot.required_ids.length > 0);
      });
      if (startup.passed) {
        let lastSnapshot = startup.result;
        for (const [index, action] of stressActions({ seed: options.seed, count: options.stress }).entries()) {
          const before = structuredClone(await engine.snapshot());
          summary.stress.attempted++;
          const outcome = await observed('stress', `${index}-${action}`, async () => {
            await engine.act({ action });
            const after = await engine.snapshot();
            const event = after.events.at(-1);
            return { before, after, evidence: event ? await engine.evidence(event.id) : null };
          }, ({ before, after }) => {
            const event = checkEngineTransition(before, after, action === 'safe' ? 'deterministic_scenario' : 'injected_fault');
            assert.equal(event.accepted, action === 'safe');
            assert.equal(after.metrics.model_calls, 0);
            if (index === 0) {
              assert.ok(after.retained_ids.length < before.retained_ids.length, 'first legal transition must usefully compact');
              assert.ok(after.metrics.context_bytes < before.metrics.context_bytes);
            }
          }, { origin: action === 'safe' ? 'deterministic_scenario' : 'injected_fault', action });
          summary.stress[outcome.passed ? 'passed' : 'failed']++;
          const event = outcome.result?.after.events.at(-1);
          if (event?.id !== before.events.at(-1)?.id && typeof event?.accepted === 'boolean') {
            summary.stress[event.accepted ? 'accepted' : 'rejected']++;
          }
          if (outcome.result) lastSnapshot = outcome.result.after;
        }
        await observed('engine', 'exact-mandatory-prompt', async () => {
          const snapshot = await engine.snapshot();
          return { snapshot, evidence: await engine.evidence(snapshot.events.at(-1).id) };
        }, ({ snapshot, evidence }) => {
          const prompts = promptStrings(evidence);
          assert.ok(prompts.length > 0, 'evidence must expose actual prompt/messages');
          for (const record of snapshot.records.filter(record => record.required)) {
            assert.ok(prompts.some(prompt => prompt.includes(record.text)), `mandatory record ${record.id} must appear verbatim in prompt`);
          }
        });

        for (let index = 0; index < options.live; index++) {
          const before = structuredClone(await engine.snapshot());
          summary.live.attempted++;
          const outcome = await observed('live', `fresh-request-${index}`, async () => {
            let operationError = null;
            try { await engine.act({ action: 'live' }); }
            catch (error) { operationError = errorRecord(error); }
            const after = await engine.snapshot();
            const event = after.events.at(-1);
            const freshEvent = event && event.id !== before.events.at(-1)?.id ? event : null;
            const evidence = freshEvent ? await engine.evidence(freshEvent.id) : null;
            if (after.error && !operationError) operationError = errorRecord(new Error(after.error));
            const provider_evidence = await providerEvidence(evidence, freshEvent, operationError);
            return { before, after, evidence, operation_error: operationError, provider_evidence,
              exchanges: modelExchangeCounts(provider_evidence) };
          }, ({ before, after, evidence, operation_error, exchanges }) => {
            if (operation_error) throw Object.assign(new Error(operation_error.message), operation_error);
            const event = checkEngineTransition(before, after, 'live_model');
            assert.ok(evidence, 'fresh request and response must be captured by engine evidence');
            assert.equal(exchanges.requests, 1, 'one fresh sponsor request must be recorded, without hidden retries');
            assert.equal(exchanges.responses, 1, 'retain the actual model response');
            assert.equal(event.origin, 'live_model');
          }, { origin: 'live_model', fresh_request_index: index });
          const operationError = outcome.result?.operation_error ?? (outcome.failure_phase === 'operation' ? outcome.error : null);
          if (operationError) summary.live[classifyLiveError(operationError)]++;
          else if (!outcome.passed) summary.live.validation_failures++;
          if (outcome.result) {
            summary.live.wire_requests += outcome.result.exchanges.requests;
            summary.live.wire_responses += outcome.result.exchanges.responses;
            const event = outcome.result.after.events.at(-1);
            if (!operationError && event?.id !== before.events.at(-1)?.id && typeof event?.accepted === 'boolean') {
              summary.live.completed++;
              summary.live[event.accepted ? 'accepted' : 'rejected']++;
            }
            lastSnapshot = outcome.result.after;
          }
        }
        await artifacts.write('engine-export.json', await engine.exportRun());
        summary.engine_metrics = lastSnapshot.metrics;
        await observed('engine', 'reset-preserves-prior-evidence', async () => {
          const priorHashes = await treeHashes(evidenceRoot);
          const oldRun = (await engine.snapshot()).run_id;
          await engine.act({ action: 'reset' });
          return { oldRun, after: await engine.snapshot(), priorHashes, afterHashes: await treeHashes(evidenceRoot) };
        }, ({ oldRun, after, priorHashes, afterHashes }) => {
          assert.ok(Object.keys(priorHashes).length > 0);
          assert.notEqual(after.run_id, oldRun);
          for (const [path, hash] of Object.entries(priorHashes)) assert.equal(afterHashes[path], hash, `prior evidence changed: ${path}`);
          checkSnapshotCounts(after);
        });
      }
    }
  } catch (error) {
    const failure = errorRecord(error);
    summary.checks.failed++;
    summary.failures.push({ suite: 'harness', name: 'unexpected-operation-error', error: failure });
    await artifacts.outcome({ suite: 'harness', passed: false, error: failure });
  } finally {
    globalThis.fetch = fetchOriginal;
    manifest.finished_at = new Date().toISOString();
    manifest.final_identities = await sourceIdentities();
    manifest.sources_changed_during_run = JSON.stringify(manifest.identities.sources) !== JSON.stringify(manifest.final_identities.sources);
    if (manifest.sources_changed_during_run) summary.unavailable.push('Sources changed during this run; retained beginning/end hashes, rerun for a stable manifest');
    summary.status = summary.checks.failed ? 'failed' : summary.unavailable.length ? 'incomplete' : 'passed';
    summary.finished_at = manifest.finished_at;
    manifest.summary = 'summary.json';
    await artifacts.write('manifest.json', manifest);
    await artifacts.write('summary.json', summary);
  }
  console.log(`Artifacts: ${relativeArtifact(artifacts.directory)}`);
  console.log(`Status: ${summary.status}; checks passed=${summary.checks.passed} failed=${summary.checks.failed}`);
  console.log(`Native: attempted=${summary.native.attempted}/${summary.native.requested} accepted=${summary.native.accepted} rejected=${summary.native.rejected} passed=${summary.native.passed} failed=${summary.native.failed}`);
  console.log(`Proof controls: attempted=${summary.mutations.attempted}/4 expected-failures=${summary.mutations.expected_proof_failures} verified-reorders=${summary.mutations.verified_reorders} failed=${summary.mutations.failed}`);
  console.log(`Deterministic stress: attempted=${summary.stress.attempted}/${summary.stress.requested} accepted=${summary.stress.accepted} rejected=${summary.stress.rejected} failed=${summary.stress.failed}`);
  console.log(`Fresh live: requested=${summary.live.requested} attempted=${summary.live.attempted} wire-requests=${summary.live.wire_requests} wire-responses=${summary.live.wire_responses} completed=${summary.live.completed} accepted=${summary.live.accepted} rejected=${summary.live.rejected} transport=${summary.live.transport} malformed=${summary.live.malformed} unavailable=${summary.live.unavailable} operation-error=${summary.live.operation_error} validation-failures=${summary.live.validation_failures}`);
  for (const reason of summary.unavailable) console.log(`NOT COMPLETE: ${reason}`);
  for (const failure of summary.failures) console.log(`FAIL ${failure.suite}/${failure.name}: ${failure.error.message}`);
  return { summary, directory: artifacts.directory };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = optionsFromArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const { summary } = await runExperiment(options);
      process.exitCode = summary.status === 'passed' ? 0 : summary.status === 'incomplete' ? 2 : 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
