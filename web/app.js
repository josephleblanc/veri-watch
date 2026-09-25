const $ = id => document.getElementById(id);
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
const originLabels = {
  deterministic_scenario: ['DETERMINISTIC', 'neutral'], injected_fault: ['INJECTED', 'injected'],
  live_model: ['LIVE MODEL', 'live'], recorded_live_model: ['RECORDED LIVE', 'replayed'],
  live_provider: ['LIVE PROVIDER', 'live'],
};
let state;
let selectedId = null;
let selectedRecord = null;
let activeTab = 'event';
let acting = false;
let connected = false;
let auto = false;
let generation = 0;
let evidenceLoading = null;
const evidenceCache = new Map();

async function request(path, options = {}, timeout = 15_000) {
  const response = await fetch(path, { cache: 'no-store', ...options, signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok) {
    if (value.state) acceptState(value.state);
    throw new Error(value.error || `HTTP ${response.status}`);
  }
  return value;
}

function notice(text, severity = '') {
  $('notice').hidden = !text;
  $('notice').className = `notice ${severity}`;
  $('notice-text').textContent = text;
}

function currentEvent() {
  return selectedId ? state?.events.find(event => event.id === selectedId) : state?.events.at(-1);
}

function badge(origin) {
  const [label, style] = originLabels[origin] || [String(origin || 'INITIAL STATE').toUpperCase(), 'neutral'];
  return el('span', `badge ${style}`, label);
}

function dataGrid(entries) {
  const grid = el('dl', 'mini-data');
  for (const [key, value] of entries) {
    const cell = el('div');
    cell.append(el('dt', '', key), el('dd', '', String(value ?? 'Not reported')));
    grid.append(cell);
  }
  return grid;
}

function raw(title, value, open = false) {
  const details = el('details', 'raw-details');
  details.open = open;
  details.append(el('summary', '', title), el('pre', 'raw-output', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  return details;
}

function syncControls() {
  const locked = !connected || !state?.kernel?.ready || acting || state.busy;
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = locked; });
  $('reset-button').disabled = !connected || acting || state?.busy;
  $('auto-button').disabled = !auto && locked;
  $('auto-button').setAttribute('aria-pressed', String(auto));
  $('auto-label').textContent = auto ? 'Pause demo' : 'Auto demo';
  $('auto-icon').textContent = auto ? 'Ⅱ' : '▷';
  const ready = id => state?.sponsors?.some(provider => provider.id === id && provider.status === 'ready');
  $('live-button').disabled = locked || !ready('liquid');
  $('ingest-button').disabled = locked || !ready('nimble');
  $('analytics-button').disabled = locked || !ready('rawtree');
  $('export-link').classList.toggle('disabled-link', !connected);
  $('export-link').setAttribute('aria-disabled', String(!connected));
  $('latest-button').disabled = !selectedId;
}

function renderKernel() {
  const kernel = state.kernel;
  $('kernel-status').textContent = kernel.ready ? `Native proof · ${kernel.active_variant}` : 'Native kernel unavailable';
  $('kernel-dot').className = `status-dot ${kernel.ready ? 'ready' : 'error'}`;
  const items = [
    ['Status', kernel.status], ['Active variant', kernel.active_variant], ['Verus', kernel.verus_version],
    ['Contract SHA-256', kernel.contract_sha256], ['Source SHA-256', kernel.source_sha256], ['Binary SHA-256', kernel.binary_sha256],
    ['Artifacts', kernel.artifact_dir],
  ];
  $('kernel-identity').replaceChildren(...items.flatMap(([key, value]) => [el('dt', '', key), el('dd', '', value || 'Unavailable')]));
  if (kernel.error) $('kernel-identity').append(el('dt', '', 'Error'), el('dd', '', kernel.error));
}

function renderMetrics(event) {
  const m = state.metrics;
  const before = event?.bytes_before ?? m.context_bytes;
  const after = event?.bytes_after ?? m.context_bytes;
  const baseline = event?.baseline_ids ?? state.baseline_ids;
  const retained = event?.after.retained_ids ?? state.retained_ids;
  const missing = ids => state.required_ids.filter(id => !ids.includes(id)).length;
  $('metric-scope').textContent = event ? `EVENT ${event.step}` : 'INITIAL';
  $('bytes-before').textContent = number(before);
  $('bytes-after').textContent = number(after);
  $('byte-delta').textContent = before === after ? 'State size preserved' : `${number(Math.abs(before - after))} bytes ${after < before ? 'removed' : 'added'}`;
  $('byte-track-fill').style.width = `${Math.min(100, before ? after / before * 100 : 0)}%`;
  $('obligation-count').textContent = number(m.required_count);
  $('obligation-detail').textContent = `${retained.length} records retained`;
  $('missing-baseline').textContent = number(missing(baseline));
  $('missing-baseline').className = missing(baseline) ? 'coral' : '';
  $('missing-verified').textContent = number(missing(retained));
  $('missing-verified').className = missing(retained) ? 'coral' : 'mint';
  $('accepted-count').textContent = number(m.accepted);
  $('rejected-count').textContent = number(m.rejected);
}

function renderWeave(event) {
  const before = event?.before.retained_ids ?? state.retained_ids;
  const baseline = event?.baseline_ids ?? state.baseline_ids;
  const after = event?.after.retained_ids ?? state.retained_ids;
  const visible = new Set([...before, ...baseline, ...after]);
  const records = state.records.filter(record => visible.has(record.id));
  // Unknown proposed IDs must be visible too, never silently hidden as success.
  for (const id of visible) if (!records.some(record => record.id === id)) {
    records.push({ id, label: 'Unknown record', text: 'This ID has no stored record.', required: false, category: 'unknown' });
  }
  records.sort((a, b) => a.id - b.id);
  const rows = records.map(record => {
    const row = el('div', 'node-row');
    const weave = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    weave.classList.add('identity-weave');
    weave.setAttribute('viewBox', '0 0 900 50');
    weave.setAttribute('preserveAspectRatio', 'none');
    weave.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(weave.namespaceURI, 'path');
    line.setAttribute('d', 'M 260 25 L 640 25');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('class', `identity-path ${record.required && !baseline.includes(record.id) ? 'lost' : 'protected'}`);
    weave.append(line);
    row.append(weave);
    [before, baseline, after].forEach((ids, lane) => {
      const present = ids.includes(record.id);
      const lost = record.required && !present;
      const protectedRecord = lane === 2 && present && record.required && !baseline.includes(record.id);
      const button = el('button', `record-node${record.required ? ' required-node' : ''}${!present ? ' discarded-node' : ''}${lost ? ' missing-node' : ''}${protectedRecord ? ' protected-node' : ''}${selectedRecord === record.id ? ' selected' : ''}`);
      button.title = record.text;
      button.setAttribute('aria-label', `${record.label}: ${['before', 'gate off', 'verified commit'][lane]}, ${present ? 'retained' : 'absent'}`);
      const label = el('span', 'node-copy');
      label.append(el('span', 'node-label', record.label), el('span', 'node-state',
        protectedRecord ? 'Commitment protected' : lost ? 'Required · missing' : present ? record.required ? 'Required · retained' : 'Retained' : 'Discarded'));
      button.append(el('span', 'node-id', String(record.id).padStart(2, '0')), label,
        el('span', 'node-icon', protectedRecord ? '✓' : record.required ? '◆' : present ? '·' : '−'));
      button.addEventListener('click', () => { selectedRecord = record.id; activeTab = 'record'; renderWeave(event); renderInspector(); });
      row.append(button);
    });
    return row;
  });
  $('node-rows').replaceChildren(...rows);
  $('weave-empty').hidden = rows.length > 0;
  $('revision-label').textContent = event ? `REV ${event.before.revision} → ${event.after.revision}` : `REV ${state.revision}`;
  $('before-lane-detail').textContent = `${before.length} retained records`;
  $('baseline-lane-detail').textContent = event?.proposal ? `${baseline.length} proposed · no gate` : 'Same snapshot · no proposal';
  $('verified-lane-detail').textContent = `${after.length} retained · ${event?.accepted === false ? 'edit rejected' : 'authoritative state'}`;
  const origin = badge(event?.origin);
  $('event-origin').className = origin.className;
  $('event-origin').textContent = origin.textContent;
  $('proposal-title').textContent = event?.title || 'Twelve authored records. Three explicit commitments. Start with a compaction.';
  const verification = event?.verification;
  const outcome = verification ? verification.activated ? 'ACTIVATED' : verification.success ? 'VERIFIED' : 'PROOF / BUILD FAILED'
    : event?.accepted === true ? 'ACCEPTED' : event?.accepted === false ? 'REJECTED' : event?.kind === 'error' ? 'ERROR' : '';
  $('event-outcome').textContent = outcome;
  $('event-outcome').className = `outcome ${event?.accepted === false || (verification && !verification.success) || event?.kind === 'error' ? 'coral' : 'mint'}`;
}

function selectEvent(id) {
  selectedId = id;
  render();
}

function renderHistory(event) {
  const events = state.events;
  $('history-position').textContent = event ? `${event.step} / ${events.length} recorded events` : 'No recorded events';
  $('history-slider').disabled = !events.length;
  $('history-slider').max = String(Math.max(0, events.length - 1));
  $('history-slider').value = String(Math.max(0, events.findIndex(item => item.id === event?.id)));
  $('history-start').textContent = events.length ? 'EVENT 1' : 'START';
  $('history-end').textContent = events.length ? `EVENT ${events.length}` : 'NOW';
  $('event-tape').replaceChildren(...events.map(item => {
    const button = el('button', `tape-event ${item.kind === 'verification' ? 'verification' : item.accepted === true ? 'accepted' : item.accepted === false ? 'rejected' : ''}`, String(item.step));
    button.title = `${item.title} · ${originLabels[item.origin]?.[0] || item.origin}`;
    button.setAttribute('aria-label', `Event ${item.step}: ${item.title}`);
    button.setAttribute('aria-pressed', String(item.id === event?.id));
    button.addEventListener('click', () => selectEvent(item.id));
    return button;
  }));
  if (!selectedId) $('event-tape').scrollLeft = $('event-tape').scrollWidth;
}

function renderInspector() {
  const event = currentEvent();
  const evidence = evidenceCache.get(event?.id);
  const content = $('inspector-content');
  document.querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === activeTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  content.setAttribute('aria-labelledby', `tab-${activeTab}`);
  content.replaceChildren();
  if (activeTab === 'record') {
    const record = state.records.find(item => item.id === selectedRecord);
    if (record) {
      content.append(badge(record.origin), el('h3', '', record.label), el('p', 'record-text', record.text));
      content.append(dataGrid([['Immutable ID', record.id], ['Classification', record.required ? 'Required' : 'Optional'], ['Category', record.category], ['Storage', 'Original text retained']]));
      if (record.source_url && /^https?:\/\//.test(record.source_url)) {
        const link = el('a', 'record-link', record.source_url);
        link.href = record.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link);
      }
      if (record.required) {
        const button = el('button', 'button mutate-button inspector-action', 'Propose dropping this commitment');
        button.disabled = acting || state.busy || !state.retained_ids.includes(record.id);
        button.addEventListener('click', () => act('drop-required', { record_id: record.id }));
        content.append(button, el('p', 'small-note', 'Explicit fault injection. The original commitment remains in the authoritative state if the native gate rejects the edit.'));
      }
    } else content.append(el('h3', '', 'Select a record'), el('p', '', 'Click any record in the three lanes to inspect its immutable text.'));
  } else if (activeTab === 'proof') {
    const verification = event?.verification;
    content.append(el('h3', '', verification ? verification.success ? 'Candidate satisfies the fixed contract' : 'Candidate was not accepted' : 'The native commit contract'));
    content.append(el('p', '', 'Accept exactly when the revision matches, it can increment, the proposed set contains only retained IDs, and every required ID remains. Reject without changing state otherwise.'));
    content.append(el('p', 'small-note', 'The “exactly when” contract also rejects a useless implementation that rejects every proposal. The candidate cannot edit the specification.'));
    if (verification) {
      content.append(dataGrid([['Variant', verification.variant], ['Verified', verification.verified], ['Proof errors', verification.errors], ['Activated', verification.activated], ['Duration', `${number(verification.duration_ms)} ms`], ['Origin', 'Injected code variant']]));
      content.append(raw('Native Verus stdout / stderr', `${verification.stdout}\n${verification.stderr}`, true));
      content.append(raw('Exact candidate source', verification.source));
    }
    if (evidence?.native) content.append(raw('Actual native runtime result', evidence.native, true));
    if (evidence?.specification) content.append(raw('Unchanged formal specification', evidence.specification));
    content.append(raw('Kernel identities', verification || evidence?.kernel || state.kernel));
    content.append(el('p', 'small-note', 'Proof scope: bounded native compaction only. Classification, stored text, host, prompts, CLI, provider data, and toolchain are trusted. Verus runs at build time; each proposal executes the compiled function.'));
  } else if (activeTab === 'model') {
    const model = evidence?.model;
    if (model) {
      content.append(badge('live_model'), el('h3', '', model.model));
      content.append(dataGrid([['Input tokens', model.input_tokens], ['Output tokens', model.output_tokens], ['Model wall time', `${number(model.duration_ms)} ms`], ['Native wall time', `${number(event.duration_ms)} ms`]]));
      content.append(raw('Actual model proposal', model.proposal, true), raw('Exact request · includes mandatory text', model.request), raw('Actual provider response', model.response));
    } else {
      content.append(el('h3', '', event?.origin === 'live_model' ? 'Inspect the failed attempt' : 'No model call for this event'));
      content.append(el('p', '', 'Deterministic and injected actions do not consume model calls. “Live agent” makes a fresh call to the installed Liquid model.'));
      if (evidence?.error) content.append(raw('Retained error', evidence.error, true));
      if (evidence?.provider_failure) content.append(raw('Actual failed provider exchange', evidence.provider_failure, true));
    }
    if (evidence?.prompt_after) content.append(raw('Rendered next-task context · not yet sent', evidence.prompt_after));
  } else if (event) {
    content.append(badge(event.origin), el('h3', '', event.title), el('p', '', event.description));
    content.append(el('p', `event-reason ${event.accepted === true ? 'accepted' : event.accepted === false ? 'rejected' : ''}`, event.reason));
    content.append(dataGrid([['Revision', `${event.before.revision} → ${event.after.revision}`], ['Native / proof time', `${number(event.duration_ms)} ms`], ['Before / after bytes', `${number(event.bytes_before)} / ${number(event.bytes_after)}`], ['Lost in ungated set', event.violated_ids.length]]));
    if (event.proposal) content.append(raw('Same proposal for both outcomes', event.proposal, true));
    if (evidence?.native) content.append(raw('Native verdict and binary identity', evidence.native));
    if (event.verification) content.append(raw('Real verifier output', `${event.verification.stdout}\n${event.verification.stderr}`, true));
    if (evidence) content.append(raw('Full event evidence', evidence));
    content.append(el('p', 'small-note', 'Gate-off is the identical proposal applied to this event’s exact starting snapshot. It is a matched counterfactual, not a second independently evolving agent.'));
  } else {
    content.append(el('h3', '', 'Start with useful forgetting'), el('p', '', 'Click Safe compact to remove optional observations. Then Drop obligation to see the same proposed edit with and without the native gate.'));
    content.append(el('p', 'event-reason', 'Afterwards, Edit harness removes the guard itself. The fixed specification must reject that implementation before it can become active.'));
    content.append(el('p', 'small-note', 'Initial records are authored scenario inputs. No model request or external observation is implied.'));
  }
  $('evidence-status').textContent = event ? evidence ? `Captured · event ${event.step}` : 'Loading exact evidence…' : 'No event selected';
  $('evidence-link').classList.toggle('disabled-link', !event);
  $('evidence-link').setAttribute('aria-disabled', String(!event));
  if (event) {
    $('evidence-link').href = `/api/evidence/${encodeURIComponent(event.id)}`;
    $('evidence-link').target = '_blank';
    $('evidence-link').rel = 'noopener';
    if (!evidence && evidenceLoading !== event.id) {
      evidenceLoading = event.id;
      request(`/api/evidence/${encodeURIComponent(event.id)}`).then(value => {
        evidenceCache.set(event.id, value);
        if (currentEvent()?.id === event.id) renderInspector();
      }).catch(error => { $('evidence-status').textContent = `Evidence error: ${error.message}`; })
        .finally(() => { if (evidenceLoading === event.id) evidenceLoading = null; });
    }
  } else $('evidence-link').removeAttribute('href');
}

function renderProviders() {
  for (const provider of state.sponsors) {
    if (!$(`${provider.id}-detail`)) continue;
    $(`${provider.id}-detail`).textContent = provider.detail;
    $(`${provider.id}-detail`).title = provider.detail;
    $(`${provider.id}-status`).textContent = provider.status.toUpperCase();
    $(`${provider.id}-status`).className = `provider-status ${provider.status}`;
  }
  const ready = state.sponsors.filter(provider => provider.status === 'ready').length;
  $('provider-note').textContent = `${ready} / ${state.sponsors.length} available · see actual operation evidence`;
}

function render() {
  if (!state) return;
  const event = currentEvent();
  $('run-label').textContent = state.run_id;
  $('run-label').title = state.run_id;
  renderKernel(); renderMetrics(event); renderWeave(event); renderHistory(event); renderInspector(); renderProviders(); syncControls();
  $('activity-status').textContent = acting || state.busy ? 'Operation in progress · native output will be retained'
    : `${state.metrics.steps} events · ${state.metrics.model_calls} live attempts · ${state.metrics.verifications} proof evaluations`;
}

function acceptState(next) {
  const changed = !state || state.run_id !== next.run_id || state.revision !== next.revision
    || state.events.length !== next.events.length || state.busy !== next.busy || state.error !== next.error
    || state.kernel.binary_sha256 !== next.kernel.binary_sha256
    || JSON.stringify(state.sponsors) !== JSON.stringify(next.sponsors);
  if (state?.run_id !== next.run_id) { selectedId = null; selectedRecord = null; evidenceCache.clear(); }
  state = next;
  connected = true;
  $('connection').className = 'connection connected';
  $('connection').lastElementChild.textContent = 'Connected';
  $('retry-button').hidden = true;
  if (changed) render();
  else syncControls();
}

async function refresh() {
  if (acting) return;
  const token = generation;
  try {
    const next = await request('/api/state');
    if (token !== generation || acting) return;
    acceptState(next);
    if (state.error) notice(state.error, 'error');
    else notice('Live local engine. Scenario steps are deterministic; injected faults and real Liquid calls are labeled separately.');
  } catch (error) {
    connected = false;
    $('connection').className = 'connection unavailable';
    $('connection').lastElementChild.textContent = 'Disconnected';
    notice(`Backend unavailable: ${error.message}`, 'error');
    $('retry-button').hidden = false;
    syncControls();
  }
}

async function act(action, extra = {}) {
  if (acting || state?.busy) return false;
  acting = true;
  selectedId = null;
  activeTab = action === 'mutate' || action === 'repair' ? 'proof' : action === 'live' ? 'model' : 'event';
  const token = ++generation;
  notice(action === 'live' ? 'Calling the actual Liquid model…'
    : action === 'mutate' || action === 'repair' ? 'Running Verus on the exact candidate and fixed contract…'
      : action === 'stress' ? 'Running 64 bounded deterministic transitions…' : 'Executing the native transition…');
  render();
  let success = false;
  try {
    const next = await request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) }, 300_000);
    if (token === generation) acceptState(next);
    success = true;
    const event = currentEvent();
    notice(action === 'reset' ? 'New run started. Previous run evidence remains on disk.' : event?.reason || 'Operation completed.', event?.accepted === false ? 'warning' : '');
  } catch (error) {
    auto = false;
    notice(error.name === 'TimeoutError' ? 'Browser wait timed out. The backend may still be working; refresh state before submitting another action.' : error.message, 'error');
  } finally {
    acting = false;
    render();
  }
  return success;
}

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { auto = false; act(button.dataset.action); }));
$('reset-button').addEventListener('click', () => { auto = false; act('reset'); });
$('retry-button').addEventListener('click', refresh);
$('latest-button').addEventListener('click', () => selectEvent(null));
$('history-slider').addEventListener('input', event => selectEvent(state.events[Number(event.target.value)]?.id || null));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { activeTab = button.dataset.tab; renderInspector(); }));
$('auto-button').addEventListener('click', async () => {
  auto = !auto;
  syncControls();
  if (!auto) return;
  for (let i = 0; i < 6 && auto; i++) {
    if (!await act('step')) break;
    await new Promise(resolve => setTimeout(resolve, 1600));
  }
  auto = false;
  syncControls();
});
$('ingest-form').addEventListener('submit', event => { event.preventDefault(); auto = false; act('ingest', { url: $('nimble-url').value }); });
$('analytics-button').addEventListener('click', async () => {
  $('analytics-dialog').showModal();
  $('analytics-output').textContent = 'Publishing unsubmitted events and querying actual provider metrics…';
  try { $('analytics-output').textContent = JSON.stringify(await request('/api/analytics', {}, 120_000), null, 2); }
  catch (error) { $('analytics-output').textContent = error.message; }
  await refresh();
});
$('close-analytics').addEventListener('click', () => $('analytics-dialog').close());
document.querySelectorAll('.disabled-link').forEach(link => link.addEventListener('click', event => { if (link.getAttribute('aria-disabled') === 'true') event.preventDefault(); }));
await refresh();
setInterval(() => { if (!document.hidden && !acting && !auto) refresh(); }, 5000);
