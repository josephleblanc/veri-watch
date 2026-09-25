# Verified native compaction kernel

`index.mjs` exports `ensureKernel()`, `runTransition(input)` and
`evaluateGuard({ variant, activate = false })` as specified in `docs/CONTRACT.md`.
Use `npm run verify` (or `node kernel/check.mjs`) for the native acceptance,
mutation, input-validation, idempotence and activation checks. No dependencies
are installed.

The trusted `source.mjs` generator has one fixed contract and five closed bodies:
`original`, `drop-required`, `reorder`, `reject-all`, `drop-revision`. Initialization
builds `original`; candidate evaluation permits the other four. Caller-provided
source and compiler options are rejected. The contract has **no requires** and
specifies acceptance **iff** all four guards hold. This rules out a rejects-all
implementation as well as unsafe acceptance.

Each successful build invokes the installed `verus` with `--no-cheating --compile`
on the exact retained source. Only a successful process with **1 verified,
0 errors** and an actual native binary may activate. `verified` is a boolean;
`verified_count` in build evidence and `errors` preserve native verifier counts
(counts are `null` when Verus did not report a result).

All generated source, binaries, raw output, process statuses, tool versions,
source/spec/binary SHA-256 digests and native requests/results live under
`target/tmp/kernel/`. The fixed `contract.rs` artifact is the hashed specification;
`contract_sha256` and `spec_sha256` are identical across all variants. Native
transition directories contain the exact active build's identity. The manifest
`active.json` changes atomically only after a successful verify-and-compile.
Initialization reuses a source-and-binary-hash-checked active build across process
restarts. An in-process queue and on-disk lock serialize builds, including builds
from concurrent Node processes. Failed candidates and preview evaluations leave
the active pointer unchanged. Successful candidate activation persists for later
processes, including after `npm run verify` (which activates `reorder`).

## Boundary and input semantics

- `revision` and `base_revision` are canonical unsigned decimal strings in the
  u64 range; JS callers may also supply `bigint`. JS numbers, signs, leading zeroes,
  whitespace and overflow are rejected, avoiding lossy number conversions.
- ID arrays contain unique integer IDs `0..63`. Returned arrays are ascending.
  BigInt encodes masks; native JSON uses decimal strings, including for bit 63.
- An in-range unknown record, missing requirement, inconsistent required mask,
  stale revision or exhausted revision reaches the **native verified function**
  and returns `accepted: false` with unchanged state. JS validates shape and
  numeric range, without deciding semantic acceptance.
- The native CLI accepts five canonical decimal arguments:
  `REVISION BASE_REVISION RETAINED REQUIRED PROPOSED`, and prints one JSON object
  with `revision`, `retained` (decimal mask) and `accepted`. Invalid CLI input exits
  2. CLI parsing/printing, JS conversion, filesystem/process handling and the
  compiler/toolchain are outside the proof; `compact` itself is verified.
- The kernel is a pure transition: callers own state storage, immutable record
  identity and serialization of state mutations. An activation cannot change the
  meaning of an already-running transition; every response identifies its binary.
- Verus/Rust are resolved from the installed environment (Rust toolchain `1.98.1`).
  Build timeout is 120 seconds, version timeout 10 seconds, native timeout 5
  seconds and cross-process lock wait 300 seconds. Compiler descendants are killed
  on timeout. Child `TMPDIR`, `TMP`, and `TEMP` point inside `target/tmp/kernel/tmp`.
