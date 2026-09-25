# VERI/WATCH experiment protocol (v1)

This is a pre-specified, bounded engineering experiment. Results exist only after
executing the native verifier/transition and, optionally, a real provider. The
repository includes **no fabricated outcomes or golden model responses**.

## Run it

From the repository root, with Node 22+ and the kernel's configured Verus toolchain:

```sh
node --test --test-concurrency=1 tests/*.test.mjs
node experiments/run.mjs --seed=0x56455249 --cases=48 --stress=64
# Opt-in only; requires configured sponsors. Six fresh calls, never replayed:
node --env-file-if-exists=.env experiments/run.mjs --live=6
```

The default run disables `fetch` and needs no sponsor credentials. Live mode is
explicit, capped at 12 calls, and preserves actual request/response evidence.
The seed controls fixture generation and scenario order; it does not make model
sampling or measured durations deterministic. Run sequentially when sharing the
checkout. The harness never edits kernel sources or activates candidate binaries.
Do not use the UI's repair action during a measured run: it intentionally changes
the active kernel and breaks fixed-binary pairing.

Every invocation creates a fresh, uniquely named directory under
`target/tmp/experiments/`. `manifest.json` records configuration, seed, start/end
timestamps, environment, commit (if any), source digests, the kernel's source /
fixed-spec / binary digests and Verus version, and each candidate's identities.
`outcomes.jsonl` contains raw inputs, independent expectations, actual native
stdout, full mutation outputs, engine snapshots/evidence, and errors; it is
appended as the run progresses. `summary.json` is the machine-readable result.
`engine-export.json` and the `engine/` subdirectory retain engine evidence. The
kernel also reports its own artifact directories; these are linked in the
manifest and raw outcomes. Beginning/end source identities expose concurrent
edits instead of silently treating a changing checkout as one experiment.

Exit 0 means all requested checks passed; exit 1 records failures; exit 2 means
required modules were unavailable or source identity changed. Tests skip absent
modules with an explicit **NOT RUN** reason. A skipped native/engine suite is not
verification success. Once modules are present, initialization/proof failures
fail tests rather than becoming skips. Nothing requires network access in tests.

## Pre-specified matrix

| Family | Default / permitted count | Expected observation |
| --- | --- | --- |
| Native set-reference differential | 48 / 25–60 | Each actual acceptance, exact revision and retained set matches a separately expressed set oracle |
| Useful positive compaction | explicit anchors + seeded legal cases | Drop optional records, preserve required text, increment revision exactly |
| Required loss | explicit + seeded | Reject, preserving both input revision and retained state |
| Stale revision | explicit + seeded | Reject even when the proposed retained set is otherwise legal |
| Unknown record | explicit + seeded | Reject a proposed ID outside the input retained set |
| Overflow | maximum `18446744073709551615` | Reject unchanged; one below maximum still accepts |
| Exact integer / high bits | IDs 31, 32, 53, 62, 63 and all 64 IDs; revisions above `2^53` | Decimal strings retain exact u64 identity; adjacent large revisions differ |
| No caller preconditions | empty sets and required IDs outside retained | Implement the total contract, not only reachable happy-path states |
| Proof negative controls | `drop-required`, `reject-all`, `drop-revision` | All fail against the **same contract SHA-256** |
| Proof positive control | `reorder` | Verifies/compiles against that same contract; does not activate |
| Engine stress | 64 / 50–100 transitions | Seeded safe / required-drop / stale actions, independent per-event checks |
| Evidence/reset | one reset after capture | New run identity; every old evidence file remains byte-identical |
| Fresh sponsor proposals | 0 by default / 1–12 explicit | Actual request, response, usage if reported, native gate outcome or error |

Native inputs are generated once from a 32-bit deterministic PRNG, with fixed
boundary anchors and a bounded random remainder. The reference uses JavaScript
`Set` inclusion and `BigInt` revision arithmetic, not copied mask predicates or
the native implementation. Both acceptance and rejection are checked, so an
always-reject gate cannot pass. These cases are not independent samples of a
deployment workload and do not estimate model error rates.

Stress begins with useful safe compaction, then exercises legal and injected
rejected transitions. It tests retention/revision behavior over a bounded
sequence; it is not a growing-context or latency throughput benchmark. Overflow
and unknown-record behavior are supplied by direct native cases, since the
engine does not expose an arbitrary revision setter.

## Pairing and measurements

For **every** proposal, gated and ungated outcomes start from the event's exact
`before` snapshot and receive identical `base_revision` / `keep_ids`. The
ungated baseline applies those proposed IDs directly. It is not a second hidden
state that drifts between calls. After a rejection the next gated snapshot must
still contain the original required records, regardless of the previous baseline.

Report counts, denominators and origins separately:

- Native cases attempted, actual accepted/rejected, oracle passes and failures.
- Proof controls attempted, expected proof failures, verified reorder, unexpected
  outcomes, and unchanged active source/spec/binary identity.
- Engine actions attempted, accepted/rejected, missing required IDs, baseline
  violations, useful retained-count reduction, and evidence/reset check outcomes.
- Fresh live actions requested/attempted/completed, actual accepted/rejected,
  recorded model wire requests/responses (excluding health checks),
  transport errors, malformed responses, unavailable configuration, other
  operation errors, and validation failures. A failed action is still an attempt;
  only provider evidence establishes that a remote request actually happened.
  Classification uses retained error text; ambiguous failures stay
  `operation_error`. No retries turn one requested action into hidden samples.
- `live_model`, `recorded_live_model`, `injected_fault` and
  `deterministic_scenario` are distinct. This harness generates no replays and
  never counts injected faults as evidence of model unreliability.

`context_bytes`, `baseline_bytes`, and `initial_bytes` are UTF-8 **bytes**, not
tokens. Retained-record counts are not token counts either. Only a provider's
actual usage fields may be reported as input/output tokens; absent usage stays
absent. Prompt evidence must contain each mandatory record's **exact text**;
mere occurrence of the text in a records metadata object is insufficient.
Durations are observed wall-clock/native values and are not a throughput claim.

## Scope and trusted computing base

The proof covers a bounded transition over one u64 revision and u64 masks: accept
iff revision matches, revision can increment, the proposed mask is a subset of
retained, and required is a subset of proposed; otherwise preserve state. It
does not prove the model correct, infer all future obligations, or prove that
labels/text were initially classified correctly.

The trusted computing base includes the fixed specification and scaffold, Verus
and its solver/toolchain, compilation/linking, executed-binary identity, CLI and
JSON parsing, JS/native boundary, record-to-ID mapping, immutable text storage,
required-record classification, prompt construction, evidence persistence, and
the platform. Differential tests sample those boundaries but are not a second
formal proof. Candidate verification must use the unchanged fixed contract and
the kernel's exact `--no-cheating --compile` path. Mutation controls always send
`activate:false`, including reorder, so a running server's active gate is not
replaced by a test candidate.

## Three-minute demonstrator notes

Use a just-completed run, not static screenshot numbers. Keep the manifest and
summary available beside the UI. A suggested sequence:

1. **0:00–0:40** — show initial retained/required counts and one actual useful
   safe compaction; label deterministic origin and byte reduction.
2. **0:40–1:20** — show an injected required-drop proposal, its same-snapshot
   ungated loss, and the native gate's unchanged retained state. Inspect the
   prompt/evidence containing the exact required record text.
3. **1:20–2:00** — show saved raw results for the three failed proof mutations
   and verified reorder, including their identical contract hash. Say these are
   injected code variants, not model-generated repairs.
4. **2:00–2:40** — show the seeded stress denominator and actual counts. If a
   fresh live run exists, show its captured sponsor request/response and honest
   success/error counts; otherwise describe live mode as unrun/unavailable.
5. **2:40–3:00** — reset, show the new run ID, and open retained prior evidence.

Do not pre-populate a successful outcome, hide malformed/transport attempts,
rename bytes to tokens, claim sponsor activity from deterministic steps, or
claim reliability percentages from deliberately injected faults. The local
tests and run directory are the demonstration data source, not this protocol.
