# Veri-Watch development

- Build the new hackathon application here. This is a shared checkout with
  parallel agents; edit only the files assigned to your work package.
- Main agent owns server.mjs, lib/, package.json, docs/, README.md and shared
  schemas. Kernel agent owns kernel/. UI agent owns web/. Sponsor agent owns
  integrations/ and .env.example. Experiment agent owns experiments/ and tests/.
- Read docs/CONTRACT.md before implementation. Coordinate interface changes with
  the main agent; do not silently change the shared contract.
- Use apply_patch to edit files. Do not commit or push unless the user asks.
- Place temporary files, model downloads, build outputs, logs and raw experiment
  runs under this repository's target/tmp. Do not use /tmp or global caches for
  new downloads. Set temporary/cache directory environment variables accordingly.
- All displayed results must come from actual native or provider outputs. Label
  live, replayed, deterministic and injected events distinctly. Never invent
  model usage, verifier success, sponsor availability or benchmark statistics.
- The exact verified native transition must own compaction decisions. Keep the
  fixed contract and trusted code-generation scaffold outside candidate edits.
- Keep this build small: Node built-ins, native Verus CLI, HTML/CSS/SVG. No Rust
  dependency installation or existing Veriwork/Graview implementation import.
