# VERI/WATCH

**Forget observations. Keep commitments.**

An interactive experiment in verified agent memory: a model proposes a smaller
working set, and a native Rust transition decides whether that edit can commit.
Then change the guard itself. An unsafe implementation must fail the same fixed
Verus specification before it can become active.

The dashboard shows the **same proposal from the same starting snapshot** in
three lanes: before the edit, gate off, and verified commit. Every verdict has
inspectable source identities, native output, and locally retained evidence.

## Run

Requirements: Node.js 22.9+ (tested on 26.8.2), `verus` on PATH, and its matching
Rust toolchain. Tested with **Verus 0.2026.09.08.67038a4 / Rust 1.98.1**.

```sh
npm start
# Open http://127.0.0.1:3000

# To reach the same dashboard from another device, e.g. over Tailscale:
HOST=0.0.0.0 npm start
```

There are no npm dependencies to install. Startup builds or hash-checks the native
kernel. `PORT` defaults to 3000. A failed startup is displayed rather than
replaced with simulated data.

### Live tools

- **Liquid AI:** local LFM2.5-1.2B-Instruct through Ollama on port 11435. “Live
  agent” makes a fresh inference request. See [setup](integrations/README.md).
- **Nimble:** fetch an actual documentation URL as a new immutable observation.
  Requires `NIMBLE_API_KEY` in the server environment or a local `.env`.
- **RawTree:** publish recorded events and query their actual aggregate counts.
  Requires `RAWTREE_API_KEY`; optionally `RAWTREE_DATABASE`.

See `.env.example`. Restart the server after changing `.env`. Keys remain
server-side and are redacted from provider evidence. Missing providers are
explicitly unavailable. Cloud adapters are implemented; authenticated Nimble and
RawTree operations were not available in the measured run below.

## Three-minute demo

1. **0:00–0:30 — The problem.** Reset with ↺. An agent needs to forget, but its
   unresolved commitments must survive. Point to the three required records.
2. **0:30–1:00 — Useful forgetting.** Click **Safe compact**. This is an explicitly
   deterministic proposal, executed by the actual native gate. Inspect the
   reduced working-context bytes.
3. **1:00–1:30 — The same bad edit, two outcomes.** Click **Drop obligation**.
   The ungated lane loses it; the verified transition rejects the edit unchanged.
   Click the record to show its exact text. **Stale edit** exercises revision
   protection independently.
4. **1:30–2:15 — Editing the harness.** **Edit harness** removes the required-set
   guard. Inspect real failed Verus output. **Verify repair** reorders the correct
   guards, verifies and compiles them, then activates that binary. These are
   labeled injected code variants, not model-written repairs.
5. **2:15–2:45 — Real model, real evidence.** Reset, then **Live agent**. Inspect
   Model I/O for the exact request, original response and provider token counts.
   A safe proposal may retain everything; acceptance is not a compression claim.
6. **2:45–3:00 — Scope.** Export JSON. “Today we prove one bounded memory
   transition. The model can propose changes; it cannot weaken this contract.”

**Auto demo** walks six deterministic/injected steps. **Stress ×64** runs a
bounded sequence of actual native transitions; neither button implies model
activity. The timeline lets you inspect earlier events without replaying them.

## The specification

`compact(revision, base_revision, retained, required, proposed)` has **no caller
preconditions**. It accepts **if and only if**:

1. The proposal's revision equals the current revision.
2. The u64 revision can increment.
3. Proposed IDs are a subset of retained IDs.
4. Every required ID remains in the proposal.

Acceptance returns the proposed set and revision + 1. Rejection preserves both
inputs exactly. The “if and only if” also rules out a vacuous rejects-all guard.
The fixed specification and source scaffold are outside candidate edits.

Verus runs with `--no-cheating --compile` on the **exact source compiled into the
native executable**. Runtime proposals execute that binary; they do not launch
the SMT verifier again. Source, contract, toolchain and binary identities are
retained. Only a successfully verified and compiled candidate can activate.

### What this proves

The proof covers a total native transition over u64 masks and a u64 revision,
with at most 64 immutable record identities in a run. It does not prove that
obligations were classified completely, summaries are faithful, fetched pages
are true, the model is correct, or the entire host is verified. The host owns
record text, serialization, storage, prompt construction, and trusted ingestion.
Live model summaries are advisory; they cannot replace required text.

Ordinary correctly implemented checks can yield identical runtime decisions.
The distinctive experiment is checking **changed implementations against the
unchanged contract**, including a useful positive control.

## Checks and observed results

```sh
npm test
npm run experiment
# Explicit opt-in: six fresh local model calls, no hidden retries
npm run experiment -- --live=6
# Additional native build/input/activation checks (activates verified reorder)
npm run verify
```

The recovery run on September 25, 2026 recorded:

| Check | Observed result |
| --- | --- |
| Existing test suite | 68 passed, 0 failed, 0 skipped |
| Added HTTP integration check | Passed: native action, evidence/export, static UI and malformed-request handling |
| Independent native set-oracle cases | 48 / 48 matched: 13 accepted, 35 rejected |
| Fixed-contract implementation controls | Three bad variants failed proof; correct reorder verified |
| Seeded 64-transition stress | 20 accepted, 44 rejected; every outcome matched expectations |
| Fresh Liquid requests after stress | 6 requests / 6 responses, all 6 accepted; no request or validation errors |
| Real-browser flow | Safe/drop/stale/mutate/repair/live controls passed; no browser exceptions |

The six-request sample follows the already-compacted stress state, so it does
not measure compression from a full context. A separate browser call on all 12
records kept all 12, despite the six-record budget. The deterministic positive
control reduced the rendered working prompt **2,079 → 1,281 UTF-8 bytes**.
These are bounded engineering observations, not estimates of deployment
reliability or demonstrations of days-long autonomous operation.

The dashboard's bytes measure the **rendered next-task working context**, not
the compaction request or provider tokens. Its context is retained in evidence;
the actual Liquid request is captured separately. Only reported provider usage
is labeled tokens. See the [experiment protocol](experiments/PROTOCOL.md).

## Evidence and architecture

```text
web/                 HTML/CSS/JS dashboard; no fabricated client-side outcomes
server.mjs           Built-in Node HTTP server and fixed routes
lib/engine.mjs       Serialized authoritative state; all compactions use native output
lib/scenario.mjs     Authored scenario and exact working-context rendering
kernel/              Fixed contract, closed candidate scaffold, native execution
integrations/        Real provider adapters and redacted raw exchanges
experiments/, tests/ Independent oracle, boundary/mutation checks and run ledger
```

Generated artifacts stay under Git-ignored `target/tmp/`:

- `kernel/`: exact sources, native binaries, verification and execution output.
- `runs/`: per-run manifest, append-only event journal, per-event evidence.
- `providers/`: provider requests and responses, including failed attempts.
- `experiments/`: source-identified manifests, raw outcomes and measured summaries.

**Export JSON** downloads the current run, including its event evidence. Reset
creates a new identity and preserves prior files. Server restarts start a new
in-memory run; checkpoint restoration is not implemented. No existing Veriwork
or graph-gallery implementation is imported; earlier research informed this
new experiment's design.
