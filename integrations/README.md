# Provider adapters

`index.mjs` exports exactly the five operations in `docs/CONTRACT.md`. It uses
Node built-ins and native `fetch`; configuration is read from the environment
on each call. The server's start command loads `.env`. See `.env.example`.

## Local Liquid

Default endpoint: **http://127.0.0.1:11435**. Default model:
**hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M**. This is the official
[Liquid Ollama deployment](https://docs.liquid.ai/deployment/on-device/ollama)
repository, explicitly selecting its smaller Q4_K_M quantization.

To start an isolated instance from this repository, first check the parent:

```sh
ls -ld .
mkdir -p target/tmp/ollama-models target/tmp/ollama-home target/tmp/ollama-cache target/tmp/providers
HOME="$PWD/target/tmp/ollama-home" \
TMPDIR="$PWD/target/tmp" XDG_CACHE_HOME="$PWD/target/tmp/ollama-cache" \
OLLAMA_MODELS="$PWD/target/tmp/ollama-models" OLLAMA_HOST=127.0.0.1:11435 \
OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=4096 ollama serve
```

In a second terminal, from the repository:

```sh
HOME="$PWD/target/tmp/ollama-home" TMPDIR="$PWD/target/tmp" \
OLLAMA_MODELS="$PWD/target/tmp/ollama-models" OLLAMA_HOST=127.0.0.1:11435 \
ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M
```

The initial setup's isolated server log/PID, download request/response/timing,
version, model digest and `/api/show` metadata are in `target/tmp/providers/`.
The generated Ollama identity and model files stay in this repository too.

### Initial setup verification (2026-09-25)

Ollama 0.34.0 successfully pulled the 730,906,680-byte model in 66.98 seconds.
`/api/show` identifies `lfm2`, 1.17B parameters, Q4_K_M; the model digest is
`5791ac70d52d5f30f115beed78283c13f5715b262bd33da417f545b7259fb1e2`.
The isolated instance used CUDA on an NVIDIA RTX 3060 Ti, offloading 17/17
layers. It remains running; its PID file is
`target/tmp/providers/ollama-11435.pid`.

Two actual compaction calls were retained. The first returned valid JSON but
kept all six records (411 input / 72 output tokens, 1,679.57 ms). After making
the budget instruction explicit, the second returned `base_revision: "7"`,
`keep_ids: [0,1,3]`, preserving both required IDs while reducing six records
to three (470 input / 62 output tokens, 231.34 ms). These are individual
measurements, not aggregate benchmark claims. See `smoke-live-result.json`
for the latest result and the separately timestamped `*-liquid-compaction-*.json`
files for both complete attempts.

`adapter-checks-result.json` records 13 passing **explicit local HTTP fixture
checks** for protocol/shape validation, timeouts, redaction and provenance.
They are not authenticated cloud successes. The live smoke check confirmed
actionable missing-key errors for all three cloud methods.

`sponsorStatus()` checks the **configured model**, both `/api/tags` and
`/api/show`, and requires a Liquid `lfm*` architecture. Reachable Ollama with
only unrelated models is not ready. Ready means installed and inspectable;
inference can still fail (for example, insufficient memory). It never pulls
models automatically and never substitutes another model.

`proposeCompaction({ records, state, budget_records, evidence_dir })` sends
the retained records, current revision, required IDs, and requested record
budget to `/api/chat` with a JSON schema. It parses the entire model content
as JSON and checks the contract shape, including unique integer IDs 0..63.
No fence stripping, response repair, retry, or substitute proposal is used.
Revision equality and retained/required-subset decisions belong to the native
kernel. A summary is optional advisory prose and cannot replace record IDs.

`request` is the redacted HTTP envelope `{method,url,headers,body}`;
`response` is the redacted native Ollama JSON object. Token counts come only
from `prompt_eval_count` / `eval_count`, when supplied. `duration_ms` is the
wall time of the inference call and decoding, excluding availability checks.

## Nimble

Requires **NIMBLE_API_KEY**. URL ingestion calls
`POST https://sdk.nimbleway.com/v2/extract`, bearer-authenticated, with
`{url, render:true, formats:["markdown"]}`. Only a successful extraction with
actual markdown is returned. The result retains the requested URL, receipt
time, task ID, SHA-256 of the returned text, HTTP request, and native response
(including Nimble's final URL, redirect metadata and query timestamp).

Official references: [Node SDK](https://docs.nimbleway.com/nimble-sdk/sdks/node),
[Extract](https://docs.nimbleway.com/nimble-sdk/web-tools/extract/quickstart),
[API](https://docs.nimbleway.com/api-reference/extract/extract), and
[documentation index](https://docs.nimbleway.com/llms.txt).
The documented search endpoint is `POST /v2/search` with `{query,...}` and
returns `{request_id,results,total_results}`. The shared contract accepts a
URL rather than a search query, so this module implements Extract only.

## RawTree

Requires **RAWTREE_API_KEY**. Optional **RAWTREE_DATABASE** becomes the
`x-rawtree-database` header. `publishEvents(events)` sends the event array to
`POST https://api.rawtree.com/v1/tables/events`; it returns the actual
`inserted` count. Include `run_id` in each event for per-run analytics.
`queryMetrics(run_id)` posts `{sql}` to `/v1/query`, grouping event counts by
`kind`, `origin` and `accepted`; returned `rows` is the provider's `data` array,
not its numeric `rows` metadata. SQL string literals are escaped.

References: [quickstart](https://rawtree.com/docs/quickstart/api),
[response/database reference](https://rawtree.com/docs/reference/api).

## Failure and evidence behavior

- Missing credentials throw actionable `ProviderError`s and status reports
  `missing`. With a key but no prior call, cloud status explicitly says
  **configured, authentication not yet tested**. A real operation updates it
  to success/error; checking status never creates paid cloud traffic.
- All network calls have bounded timeouts covering the body read and reject
  redirects. `LIQUID_TIMEOUT_MS` defaults to 120 s (max 300 s),
  `PROVIDER_TIMEOUT_MS` to 45 s (max 180 s), and each readiness request to
  `PROVIDER_STATUS_TIMEOUT_MS`, 5 s (max 15 s).
- Each operation, including missing-key calls and malformed model output,
  writes a uniquely named JSON evidence file. `evidence_dir` must be inside
  this repository's `target/tmp`; default is `target/tmp/providers`.
  Failed calls carry `error.evidence_path`; model failures also retain any
  actual usage counts. Success returns `evidence_path` for compaction per the
  contract. Cloud evidence is retained on disk even when its return schema
  has no path field. Readiness checks do not generate evidence files.
- Evidence includes full raw HTTP text (even malformed JSON), parsed native
  responses where possible, requests, timings, HTTP status, and errors.
  Known API keys, bearer credentials, sensitive credential fields and URL
  token parameters are redacted in evidence, status and returned values.
  Apart from credential redaction, model output is preserved as received.
- Failed operations throw; no invented observations, insertion counts,
  analytics rows, model outputs or usage are returned. In particular, an
  ambiguous insertion timeout is not reported as zero inserted events.
