// Independent, set-based oracle. Deliberately does not use the kernel's masks.
export const U64_MAX = 18446744073709551615n;
export const DEFAULT_SEED = 0x56455249;

export function sortedIds(ids) {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export function referenceTransition(input) {
  const revision = BigInt(input.revision);
  const retained = new Set(input.retained_ids);
  const proposed = new Set(input.keep_ids);
  const required = new Set(input.required_ids);
  const accepted = BigInt(input.base_revision) === revision
    && revision < U64_MAX
    && [...proposed].every(id => retained.has(id))
    && [...required].every(id => proposed.has(id));
  return {
    accepted,
    revision: accepted ? String(revision + 1n) : input.revision,
    retained_ids: sortedIds(accepted ? proposed : retained),
  };
}

export function seededRandom(seed = DEFAULT_SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function nativeCases({ seed = DEFAULT_SEED, count = 48 } = {}) {
  if (!Number.isInteger(count) || count < 25 || count > 60) {
    throw new RangeError('Native case count must be an integer in 25..60');
  }
  const cases = [];
  const add = (name, input, category = name) => {
    const expected = referenceTransition(input);
    cases.push({ name, category, origin: expected.accepted ? 'deterministic_scenario' : 'injected_fault', input, expected });
  };
  const input = (revision, retained_ids, required_ids, keep_ids, base_revision = revision) => ({
    revision, base_revision, retained_ids, required_ids, keep_ids,
  });
  add('useful-compaction', input('7', [0, 1, 2, 63], [0, 63], [0, 63]));
  add('required-loss', input('7', [0, 1, 63], [0, 63], [0]));
  add('stale', input('7', [0, 1, 63], [0, 63], [0, 63], '6'));
  add('unknown-record', input('7', [0, 1], [0], [0, 63]));
  add('overflow', input(String(U64_MAX), [0, 63], [63], [63]));
  add('last-increment', input(String(U64_MAX - 1n), [0, 63], [63], [63]));
  add('exact-above-js-safe-integer', input('9007199254740993', [31, 32, 53, 62, 63], [32, 63], [32, 63]));
  add('nearby-high-revisions-are-not-equal', input('9007199254740993', [63], [63], [63], '9007199254740992'));
  add('empty-state', input('0', [], [], []));
  add('empty-required-can-drop-all', input('0', [0, 31, 32, 63], [], []));
  add('required-outside-retained', input('0', [1], [63], [1]));
  add('all-64-ids', input('4294967297', Array.from({ length: 64 }, (_, id) => id), [0, 31, 32, 63], [0, 31, 32, 63]));
  const random = seededRandom(seed);
  while (cases.length < count) {
    const number = cases.length;
    const retained = Array.from({ length: 64 }, (_, id) => id).filter(() => random() < 0.45);
    if (!retained.includes(63)) retained.push(63);
    const required = retained.filter(() => random() < 0.3);
    if (!required.length) required.push(retained[0]);
    const keep = retained.filter(id => required.includes(id) || random() < 0.45);
    let revision = String((BigInt(Math.floor(random() * 0xffffffff)) << 32n)
      + BigInt(Math.floor(random() * 0xffffffff)));
    let base = revision;
    const category = ['legal', 'required-loss', 'stale', 'unknown-record', 'overflow'][number % 5];
    if (category === 'required-loss') keep.splice(keep.indexOf(required[0]), 1);
    if (category === 'stale') base = String(BigInt(revision) ^ 1n);
    if (category === 'unknown-record') {
      const unknown = Array.from({ length: 64 }, (_, id) => id).find(id => !retained.includes(id));
      // The high-bit anchor remains retained; force a distinct unknown if necessary.
      const id = unknown ?? 0;
      if (unknown === undefined) retained.splice(retained.indexOf(id), 1);
      keep.push(id);
    }
    if (category === 'overflow') revision = base = String(U64_MAX);
    add(`seed-${seed}-${number}-${category}`, input(revision, sortedIds(retained), sortedIds(required), sortedIds(keep), base), category);
  }
  return cases;
}

export function stressActions({ seed = DEFAULT_SEED, count = 64 } = {}) {
  if (!Number.isInteger(count) || count < 50 || count > 100) {
    throw new RangeError('Stress transition count must be an integer in 50..100');
  }
  const random = seededRandom(seed ^ 0x53545253);
  return Array.from({ length: count }, (_, index) => index === 0 ? 'safe'
    : ['safe', 'drop-required', 'stale'][Math.floor(random() * 3)]);
}
