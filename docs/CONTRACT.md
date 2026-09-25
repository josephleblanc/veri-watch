# Shared build contract — v1

Project name: **VERI/WATCH**. Tagline: **Forget observations. Keep commitments.**
Visual: polished dark editorial/dashboard, mint proof status, warm red rejected
edits, amber obligations; stable graph/card positions and inspectable evidence.

## Ownership

Main agent: server.mjs, lib/, docs/, package.json, README.md.
Kernel agent: kernel/. UI agent: web/. Sponsor agent: integrations/, .env.example.
Experiment agent: experiments/, tests/. All raw output: target/tmp/.

## Native kernel API (kernel/index.mjs)

Use u64 masks internally, decimal strings on CLI/JSON; JS BigInt or ID arrays.
Immutable records use IDs 0..63, never reused within a run.

```js
await ensureKernel() // => KernelStatus
await runTransition({ revision, base_revision, retained_ids, required_ids, keep_ids })
// => { revision: string, retained_ids: number[], accepted: boolean,
//      duration_ms: number, stdout: string, binary_sha256: string }
await evaluateGuard({ variant, activate: false })
// variant: 'drop-required' | 'reorder' | 'reject-all' | 'drop-revision'
// => { success, verified, errors, duration_ms, stdout, stderr,
//      source_sha256, contract_sha256, binary_sha256?, artifact_dir,
//      source, variant, activated }
```

`ensureKernel()` is idempotent and returns current active status. Passing
`activate:true` to evaluateGuard installs a successfully verified binary only.
KernelStatus = { ready, status, source_sha256?, contract_sha256?, binary_sha256?,
verus_version?, verified?, errors?, active_variant?, artifact_dir?, error? }.

Contract: accepted IFF base revision equals current, revision has room to
increment, proposed subset retained, and required subset proposed. Accepted
returns proposed mask and incremented revision; rejected returns inputs
unchanged. No caller preconditions. Compile the exact verified source with
`--no-cheating --compile`. main CLI parsing is outside the proof. Preserve raw
verification and compilation outputs, source/binary/spec digests. A rejects-all
candidate must fail. Good/bad scratch examples are available at
`/home/brasides/code/toys/veriwork/target/tmp/long-horizon-hack-planning-20260925/`.

## Sponsor module API (integrations/index.mjs)

```js
await sponsorStatus()
// => [{ id: 'liquid'|'nimble'|'rawtree', name, status: 'ready'|'missing'|'error', detail }]
await proposeCompaction({ records, state, budget_records, evidence_dir })
// => { proposal: { base_revision: string, keep_ids: number[], rationale, summary? },
//      model, origin:'live_model', duration_ms, input_tokens?, output_tokens?,
//      request, response, evidence_path? }
await fetchObservations({ url, evidence_dir })
// => { text, url, fetched_at, request_id?, content_sha256, request, response }
await publishEvents(events) // => { inserted, status, error? }
await queryMetrics(run_id) // => { status, rows?, error? }
```

Missing credentials must throw an actionable error for called operations and
be accurately reflected by sponsorStatus. Never substitute fixture data for a
live provider response. All HTTP calls bounded. No keys in public status/logs.

## Server API

GET /api/state => Snapshot below.
POST /api/action with JSON => updated Snapshot (errors: { error, state? }).
Actions: `step`, `safe`, `drop-required`, `stale`, `live`, `mutate`, `repair`,
`reset`, `ingest`, `stress`, `compact`.

- step walks a deterministic demonstration (safe/drop-required/stale/etc.).
- safe produces a useful legal proposal from current records.
- drop-required and stale are explicitly injected faults.
- live calls the real model through the sponsor module.
- mutate evaluates drop-required guard; repair evaluates reorder and activates
  it on success. These are labeled injected code variants unless a real model
  request is recorded separately.
- compact may include keep_ids:number[] and base_revision:string.
- ingest may include url:string and uses Nimble.
- stress executes a bounded deterministic local transition stress run.
- reset starts a new in-memory scenario/run, retaining old evidence on disk.

GET /api/evidence/:event_id => exact evidence for a known event.
GET /api/export => full run manifest/events as downloadable JSON.
GET /api/analytics => real RawTree query result or explicit unavailable state.

## Snapshot

```js
{
  run_id: string,
  revision: string,
  records: [{ id:number, label:string, text:string, required:boolean,
              category:string, source_url?:string, origin:string }],
  required_ids: number[],
  retained_ids: number[],
  baseline_ids: number[], // latest identical proposal without gate, matched snapshot
  events: Event[],        // oldest first; UI can reverse
  metrics: {
    steps, accepted, rejected, unsafe_baseline, context_bytes, initial_bytes,
    baseline_bytes, retained_count, required_count, model_calls,
    missing_required, protected_rejections, verifications
  },
  kernel: KernelStatus,
  sponsors: SponsorStatus[],
  busy: boolean,
  error: string|null,
  next_action: string
}
```

Event = { id:string, step:number, at:string, kind:string, origin:string,
title:string, description:string, before:{revision,retained_ids},
after:{revision,retained_ids}, proposal?:{base_revision,keep_ids,rationale,summary?},
baseline_ids:number[], accepted:boolean|null, reason:string,
violated_ids:number[], bytes_before:number, bytes_after:number,
duration_ms:number, evidence_path?:string, verification?:object }.

Origins: live_model | recorded_live_model | injected_fault |
deterministic_scenario | live_provider. `live_provider` identifies actual Nimble
ingestion, a trusted host operation outside the compaction proof. A kernel verification event differs from a runtime
transition event. Do not call bytes tokens. Do not imply model activity when
stepping deterministic scenarios. Same-proposal baseline always starts from the
same snapshot as the gated transition, not a separately evolving hidden state.

## Experiments

Export main state engine from lib/engine.mjs (main agent owns it):
`createEngine({ evidenceRoot? })` -> object with async `init()`, `snapshot()`,
async `act({ action, ... })`, `evidence(eventId)`, `exportRun()`, `analytics()`.
Analytics explicitly publishes unsubmitted events before querying RawTree;
deterministic engine steps do not issue cloud analytics calls. `context_bytes`
measures the rendered next-task working prompt, not the separate compactor
request. Both are retained when a model is called. `model_calls` counts fresh live
action attempts; actual wire-request counts are derived from provider exchanges
by the experiment harness, including failed attempts.
Engine uses the native kernel and integrations, serializes all mutations, and
logs JSONL under target/tmp. Test native transition directly while engine is
being built. UI must handle startup/unavailable states honestly.

Stress-run scheduling: 50–100 bounded deterministic compactions, optional
6–12 live proposals once a local Liquid model is ready. Include positive
compression, required-drop, stale, unknown-record, overflow and candidate
mutation/reject-all controls. Retain every outcome and label origins. No fake
statistical claims or live-call counts.
