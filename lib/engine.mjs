import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ensureKernel, runTransition, evaluateGuard } from '../kernel/index.mjs';
import { CONTRACT } from '../kernel/source.mjs';
import { sponsorStatus, proposeCompaction, fetchObservations, publishEvents, queryMetrics } from '../integrations/index.mjs';
import { scenarioRecords, workingPrompt } from './scenario.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TMP = join(ROOT, 'target/tmp');
const MAX_REVISION = (1n << 64n) - 1n;
const DEMO = ['safe', 'drop-required', 'stale', 'mutate', 'repair', 'safe'];
const copy = value => structuredClone(value);
const json = value => JSON.stringify(value, null, 2) + '\n';
const sorted = ids => [...ids].sort((a, b) => a - b);

export function createEngine({ evidenceRoot = join(TMP, 'runs') } = {}) {
  evidenceRoot = resolve(evidenceRoot);
  const inside = relative(TMP, evidenceRoot);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) {
    throw new Error('Engine evidenceRoot must be inside this repository’s target/tmp.');
  }
  let state;
  let initialized;
  let queue = Promise.resolve();
  let pending = 0;
  let demoIndex = 0;
  let runDir;
  let manifest;
  let initialBytes = 0;
  let published = 0;
  const evidenceFiles = new Map();
  const beforeState = () => ({ revision: state.revision, retained_ids: [...state.retained_ids] });
  const prompt = ids => workingPrompt(state.records, ids);
  const bytes = ids => Buffer.byteLength(prompt(ids), 'utf8');

  function metrics() {
    const transitions = state.events.filter(event => typeof event.accepted === 'boolean');
    const unsafe = event => state.required_ids.some(id => !event.baseline_ids.includes(id));
    return {
      steps: state.events.length,
      accepted: transitions.filter(event => event.accepted).length,
      rejected: transitions.filter(event => !event.accepted).length,
      unsafe_baseline: transitions.filter(unsafe).length,
      context_bytes: bytes(state.retained_ids), initial_bytes: initialBytes,
      baseline_bytes: bytes(state.baseline_ids),
      retained_count: state.retained_ids.length, required_count: state.required_ids.length,
      model_calls: state.events.filter(event => event.origin === 'live_model').length,
      missing_required: state.required_ids.filter(id => !state.retained_ids.includes(id)).length,
      protected_rejections: transitions.filter(event => !event.accepted && unsafe(event)).length,
      verifications: state.events.filter(event => event.kind === 'verification').length,
    };
  }

  function snapshot() {
    if (!state) throw new Error('Engine is not initialized.');
    return copy({ ...state, metrics: metrics(), busy: pending > 0, next_action: DEMO[demoIndex % DEMO.length] });
  }

  async function newRun(kernel, sponsors) {
    const records = scenarioRecords();
    const ids = records.map(record => record.id);
    state = {
      run_id: `run-${randomUUID()}`, revision: '0', records,
      required_ids: records.filter(record => record.required).map(record => record.id),
      retained_ids: ids, baseline_ids: [...ids], events: [], kernel, sponsors, error: null,
    };
    demoIndex = 0;
    published = 0;
    initialBytes = bytes(ids);
    runDir = join(evidenceRoot, state.run_id);
    await mkdir(runDir, { recursive: true });
    manifest = {
      schema: 'veri-watch-run-v1', run_id: state.run_id, created_at: new Date().toISOString(),
      records, initial_state: beforeState(), required_ids: state.required_ids,
      kernel, specification: CONTRACT,
      context_measurement: 'UTF-8 bytes of the rendered next-task working prompt; not provider tokens or compaction-request bytes.',
      proof_boundary: 'Only the native compact transition is verified. Specification, classification, immutable record storage, prompt construction, host serialization, CLI, providers and toolchain are trusted.',
    };
    await writeFile(join(runDir, 'manifest.json'), json(manifest), { flag: 'wx' });
  }

  async function init() {
    if (!initialized) initialized = (async () => {
      const kernel = await ensureKernel();
      if (!kernel.ready) throw new Error(kernel.error || 'Native kernel could not be verified and compiled.');
      await newRun(kernel, await sponsorStatus());
    })();
    await initialized;
    return snapshot();
  }

  function baseEvent(kind, origin, title, description) {
    const before = beforeState();
    return {
      id: `event-${randomUUID()}`, step: state.events.length + 1, at: new Date().toISOString(),
      kind, origin, title, description, before, after: copy(before),
      baseline_ids: [...before.retained_ids], accepted: null, reason: '', violated_ids: [],
      bytes_before: bytes(before.retained_ids), bytes_after: bytes(before.retained_ids), duration_ms: 0,
    };
  }

  async function record(event, details) {
    const path = join(runDir, `${String(event.step).padStart(4, '0')}-${event.id}.json`);
    event.evidence_path = path;
    const evidence = {
      schema: 'veri-watch-event-v1', run_id: state.run_id, event,
      required_ids: [...state.required_ids], records: copy(state.records),
      kernel: copy(state.kernel), specification: CONTRACT,
      prompt_before: prompt(event.before.retained_ids),
      prompt_after: prompt(event.after.retained_ids),
      prompt_note: 'Rendered next-task working context. Actual model requests, when made, are captured separately under model.request.',
      ...details,
    };
    // Persist the result before changing the authoritative in-memory snapshot.
    await writeFile(path, json(evidence), { flag: 'wx' });
    await appendFile(join(runDir, 'events.jsonl'), JSON.stringify(event) + '\n');
    evidenceFiles.set(event.id, path);
    state.events.push(event);
  }

  function safeIds() {
    const optional = state.retained_ids.filter(id => !state.required_ids.includes(id));
    return sorted([...state.required_ids, ...optional.slice(0, Math.floor(optional.length / 2))]);
  }

  async function transition(action, input) {
    let model;
    let proposal;
    let origin = action === 'safe' ? 'deterministic_scenario' : 'injected_fault';
    if (action === 'live') {
      origin = 'live_model';
      model = await proposeCompaction({
        records: copy(state.records), state: { ...beforeState(), required_ids: [...state.required_ids] },
        budget_records: Math.max(state.required_ids.length, Math.floor(state.retained_ids.length / 2)),
        evidence_dir: join(runDir, 'providers'),
      });
      proposal = model.proposal;
    } else if (action === 'compact') {
      proposal = { base_revision: input.base_revision, keep_ids: input.keep_ids, rationale: 'Manually supplied proposal; explicitly injected, not model-generated.' };
    } else {
      let keep = safeIds();
      let base = state.revision;
      let rationale = 'Keep all commitments and remove at least half of optional observations.';
      if (action === 'drop-required') {
        const id = input.record_id ?? state.required_ids[0];
        if (!state.required_ids.includes(id)) throw new Error('Choose a required record to inject an obligation-loss fault.');
        keep = state.retained_ids.filter(item => item !== id);
        rationale = `Injected fault: remove required record ${id}. This is not a model error.`;
      }
      if (action === 'stale') {
        base = state.revision === '0' ? '1' : String(BigInt(state.revision) - 1n);
        rationale = 'Injected fault: commit a proposal composed against a different revision.';
      }
      proposal = { base_revision: base, keep_ids: keep, rationale };
    }
    const titles = { safe: 'A useful, legal compaction', 'drop-required': 'A commitment is proposed for deletion', stale: 'A stale proposal reaches the commit boundary', live: 'Liquid proposes a new working set', compact: 'A manually supplied keep set' };
    const event = baseEvent('transition', origin, titles[action], proposal.rationale);
    const native_input = {
      revision: state.revision, base_revision: proposal.base_revision,
      retained_ids: [...state.retained_ids], required_ids: [...state.required_ids], keep_ids: copy(proposal.keep_ids),
    };
    // Semantic acceptance and the next state come ONLY from the compiled,
    // verified function. The JS explanation below is not an acceptance gate.
    const native = await runTransition(native_input);
    event.proposal = copy(proposal);
    event.baseline_ids = sorted(proposal.keep_ids);
    event.accepted = native.accepted;
    event.after = { revision: native.revision, retained_ids: native.retained_ids };
    event.violated_ids = state.required_ids.filter(id => !proposal.keep_ids.includes(id));
    const reasons = [];
    if (proposal.base_revision !== state.revision) reasons.push('base revision does not match current revision');
    if (state.revision === String(MAX_REVISION)) reasons.push('revision cannot increment');
    if (proposal.keep_ids.some(id => !state.retained_ids.includes(id))) reasons.push('proposal introduces an ID outside the retained set');
    if (event.violated_ids.length) reasons.push(`required record${event.violated_ids.length === 1 ? '' : 's'} ${event.violated_ids.join(', ')} would be lost`);
    event.reason = native.accepted ? 'Native gate accepted: all four conditions hold.' : `Native gate rejected: ${reasons.join('; ') || 'inspect native evidence'}. State preserved.`;
    event.bytes_after = bytes(native.retained_ids);
    event.duration_ms = native.duration_ms;
    if (model) {
      event.model = model.model;
      event.model_duration_ms = model.duration_ms;
      for (const key of ['input_tokens', 'output_tokens']) if (model[key] !== undefined) event[key] = model[key];
    }
    await record(event, { native_input, native, ...(model ? { model } : {}) });
    state.revision = native.revision;
    state.retained_ids = [...native.retained_ids];
    state.baseline_ids = [...event.baseline_ids];
  }

  async function verify(action) {
    const variant = action === 'repair' ? 'reorder' : 'drop-required';
    const previous = copy(state.kernel);
    const result = await evaluateGuard({ variant, activate: action === 'repair' });
    const event = baseEvent('verification', 'injected_fault',
      action === 'repair' ? 'A correct guard reorder is checked for activation' : 'An edited harness tries to remove the commitment guard',
      'Explicitly supplied code variant. Verus checks the unchanged contract; this is not a model-generated patch.');
    event.verification = result;
    event.duration_ms = result.duration_ms;
    event.reason = result.activated ? 'Verified and compiled under the same fixed contract. New native binary activated.'
      : result.success ? 'Candidate verified; active binary unchanged.'
        : result.errors > 0 ? `Verus rejected the candidate with ${result.errors} proof error(s). Active binary unchanged.`
          : 'Candidate verification/build did not succeed. Inspect the native error; active binary unchanged.';
    await record(event, { verification: result, kernel_before: previous });
    state.kernel = await ensureKernel();
    state.baseline_ids = [...state.retained_ids];
  }

  async function ingest(input) {
    if (state.records.length >= 64) throw new Error('This run has used all 64 immutable record IDs. Reset to start a new run.');
    if (BigInt(state.revision) === MAX_REVISION) throw new Error('Revision is exhausted. Reset to start a new run.');
    const observation = await fetchObservations({ url: input.url, evidence_dir: join(runDir, 'providers') });
    const event = baseEvent('observation', 'live_provider', 'Nimble adds a fresh observation',
      'Trusted host ingestion; not covered by the compaction proof. Original provider response is retained.');
    const recordValue = {
      id: state.records.length, label: `Source: ${new URL(observation.url).hostname}`, text: observation.text.slice(0, 3000),
      required: false, category: 'external', origin: 'live_provider', source_url: observation.url,
      fetched_at: observation.fetched_at, content_sha256: observation.content_sha256,
      excerpt: observation.text.length > 3000,
    };
    const records = [...state.records, recordValue];
    event.after = { revision: String(BigInt(state.revision) + 1n), retained_ids: [...state.retained_ids, recordValue.id] };
    event.baseline_ids = [...event.after.retained_ids];
    event.reason = `Added immutable record ${recordValue.id}; all commitments preserved. Excerpt capped at 3,000 characters.`;
    event.bytes_after = Buffer.byteLength(workingPrompt(records, event.after.retained_ids));
    await record(event, { observation, added_record: recordValue, prompt_after: workingPrompt(records, event.after.retained_ids) });
    state.records = records;
    state.revision = event.after.revision;
    state.retained_ids = [...event.after.retained_ids];
    state.baseline_ids = [...event.baseline_ids];
  }

  async function perform(input) {
    const action = input.action;
    state.error = null;
    if (action === 'reset') {
      await newRun(await ensureKernel(), state.sponsors);
    } else if (action === 'step') {
      await perform({ action: DEMO[demoIndex % DEMO.length] });
      demoIndex++;
    } else if (['safe', 'drop-required', 'stale', 'live', 'compact'].includes(action)) {
      await transition(action, input);
    } else if (action === 'mutate' || action === 'repair') {
      await verify(action);
    } else if (action === 'ingest') {
      await ingest(input);
    } else if (action === 'stress') {
      const count = input.count ?? 64;
      if (!Number.isInteger(count) || count < 50 || count > 100) throw new Error('Stress count must be between 50 and 100.');
      for (let i = 0; i < count; i++) await perform({ action: ['safe', 'drop-required', 'stale'][i % 3] });
    } else throw new Error(`Unknown action: ${String(action)}`);
  }

  function enqueue(work) {
    if (pending >= 16) return Promise.reject(new Error('Too many queued actions; wait for the current operation.'));
    pending++;
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task.finally(() => { pending--; });
  }

  async function act(input) {
    const request = copy(input);
    await init();
    await enqueue(async () => {
      try { await perform(request); }
      catch (error) {
        state.error = error.message;
        const event = baseEvent('error', request.action === 'live' ? 'live_model'
          : request.action === 'ingest' ? 'live_provider' : 'deterministic_scenario',
        'Operation did not complete', error.message);
        event.reason = 'No successful transition is claimed. Inspect the saved error and provider evidence.';
        const failure = { message: error.message, code: error.code, evidence_path: error.evidence_path };
        await record(event, { error: failure });
        throw error;
      } finally {
        if (request.action === 'live' || request.action === 'ingest') state.sponsors = await sponsorStatus();
      }
    });
    return snapshot();
  }

  async function evidence(eventId) {
    const path = evidenceFiles.get(eventId);
    if (!path) throw new Error('Unknown event ID.');
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async function exportRun() {
    const snap = snapshot();
    return { manifest: copy(manifest), ...snap, evidence: await Promise.all(snap.events.map(event => evidence(event.id))) };
  }

  async function analytics() {
    await init();
    return enqueue(async () => {
      try {
        const unpublished = state.events.slice(published);
        let publication = null;
        if (unpublished.length) {
          publication = await publishEvents(unpublished.map(event => ({ ...event, run_id: state.run_id })));
          if (publication.inserted !== unpublished.length) throw new Error('RawTree reported a partial insertion. Inspect provider evidence before retrying.');
          published = state.events.length;
        }
        return { ...await queryMetrics(state.run_id), run_id: state.run_id, publication };
      } catch (error) { return { status: 'unavailable', error: error.message, evidence_path: error.evidence_path }; }
      finally { state.sponsors = await sponsorStatus(); }
    });
  }

  return { init, snapshot, act, evidence, exportRun, analytics };
}
