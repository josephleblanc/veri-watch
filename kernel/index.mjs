import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { CONTRACT, CANDIDATE_VARIANTS, generateSource } from './source.mjs';
import {
  ROOT, BUILD_TIMEOUT_MS, NATIVE_TIMEOUT_MS, prepareDirectories,
  writeJSON, runAndRecord, exitedSuccessfully,
} from './process.mjs';

const U64_MAX = (1n << 64n) - 1n;
const ACTIVE_PATH = join(ROOT, 'active.json');
const LOCK_PATH = join(ROOT, 'compile.lock');
const RECOVERY_PATH = join(ROOT, 'lock-recovery');
const LOCK_TIMEOUT_MS = 300_000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const contractHash = sha256(CONTRACT);
let queue = Promise.resolve();
let ensureInFlight;

function objectWithKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${name}: unexpected field ${String(key)}`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      throw new TypeError(`${name}: accessor fields are not supported`);
    }
  }
}

function decimalU64(value, name) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > U64_MAX) throw new RangeError(`${name} is outside u64`);
    return value.toString();
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned decimal string or bigint`);
  }
  const number = BigInt(value);
  // JS's $ anchor also matches before a terminal newline; require exact form.
  if (number.toString() !== value) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  if (number > U64_MAX) throw new RangeError(`${name} is outside u64`);
  return value;
}

function idsToMask(ids, name) {
  if (!Array.isArray(ids) || ids.length > 64) throw new TypeError(`${name} must be an ID array (0..63)`);
  let mask = 0n;
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id > 63) throw new RangeError(`${name}: ID must be an integer in 0..63`);
    const bit = 1n << BigInt(id);
    if ((mask & bit) !== 0n) throw new TypeError(`${name}: duplicate ID ${id}`);
    mask |= bit;
  }
  return mask.toString();
}

function maskToIds(value) {
  const mask = BigInt(decimalU64(value, 'native retained mask'));
  return Array.from({ length: 64 }, (_, id) => id).filter((id) => (mask & (1n << BigInt(id))) !== 0n);
}

function normalizeInput(input) {
  objectWithKeys(input, ['revision', 'base_revision', 'retained_ids', 'required_ids', 'keep_ids'], 'transition');
  const revision = decimalU64(input.revision, 'revision');
  const baseRevision = decimalU64(input.base_revision, 'base_revision');
  const retained = idsToMask(input.retained_ids, 'retained_ids');
  const required = idsToMask(input.required_ids, 'required_ids');
  const proposed = idsToMask(input.keep_ids, 'keep_ids');
  return {
    revision, base_revision: baseRevision,
    retained_ids: maskToIds(retained), required_ids: maskToIds(required), keep_ids: maskToIds(proposed),
    masks: { retained, required, proposed },
  };
}

async function recoverAbandonedLock() {
  // Only one waiter may remove an abandoned lock. Without this separate claim,
  // two waiters could both remove it, with one deleting a newly acquired lock.
  try { await mkdir(RECOVERY_PATH); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    try {
      const owner = JSON.parse(await readFile(join(LOCK_PATH, 'owner.json'), 'utf8'));
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') await rm(LOCK_PATH, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A just-created lock may not have its owner file yet.
      try {
        if (Date.now() - (await stat(LOCK_PATH)).mtimeMs > LOCK_TIMEOUT_MS) {
          await rm(LOCK_PATH, { recursive: true, force: true });
        }
      } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    }
  } finally { await rm(RECOVERY_PATH, { recursive: true, force: true }); }
}

async function withBuildLock(operation) {
  await prepareDirectories();
  const started = performance.now();
  const token = randomUUID();
  while (true) {
    try {
      await mkdir(LOCK_PATH);
      try {
        await writeJSON(join(LOCK_PATH, 'owner.json'), { pid: process.pid, token });
      } catch (error) {
        await rm(LOCK_PATH, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await recoverAbandonedLock();
      if (performance.now() - started > LOCK_TIMEOUT_MS) throw new Error('Timed out waiting for the kernel build lock');
      await delay(50);
    }
  }
  try { return await operation(); }
  finally {
    const owner = JSON.parse(await readFile(join(LOCK_PATH, 'owner.json'), 'utf8'));
    if (owner.token === token) await rm(LOCK_PATH, { recursive: true, force: true });
  }
}

function serializeBuild(operation) {
  const result = queue.then(() => withBuildLock(operation));
  queue = result.catch(() => {});
  return result;
}

function publicStatus(build) {
  return {
    ready: build.success,
    status: build.success ? 'verified' : 'error',
    source_sha256: build.source_sha256,
    contract_sha256: build.contract_sha256,
    ...(build.binary_sha256 ? { binary_sha256: build.binary_sha256 } : {}),
    verus_version: build.verus_version,
    verified: build.verified, errors: build.errors,
    ...(build.success ? { active_variant: build.variant } : {}),
    artifact_dir: build.artifact_dir,
    ...(build.error ? { error: build.error } : {}),
  };
}

async function loadActive() {
  try {
    const build = JSON.parse(await readFile(ACTIVE_PATH, 'utf8'));
    const path = relative(ROOT, build.artifact_dir);
    if (!path || isAbsolute(path) || path.startsWith('..') || basename(path) !== path
        || !path.startsWith('build-') || !build.success || build.errors !== 0
        || build.verified !== true || build.verified_count !== 1
        || build.contract_sha256 !== contractHash) return null;
    const expectedSource = generateSource(build.variant);
    if (sha256(expectedSource) !== build.source_sha256) return null;
    const [source, binary] = await Promise.all([
      readFile(join(build.artifact_dir, 'source.rs')),
      readFile(join(build.artifact_dir, 'kernel-native')),
    ]);
    if (sha256(source) !== build.source_sha256 || sha256(binary) !== build.binary_sha256) return null;
    return build;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

async function buildVariant(variant) {
  const started = performance.now();
  const source = generateSource(variant);
  const directory = await mkdtemp(join(ROOT, `build-${variant}-`));
  const sourcePath = join(directory, 'source.rs');
  const binaryPath = join(directory, 'kernel-native');
  const sourceHash = sha256(source);
  await Promise.all([
    writeFile(sourcePath, source),
    writeFile(join(directory, 'contract.rs'), CONTRACT),
    writeJSON(join(directory, 'hashes.json'), { source_sha256: sourceHash, contract_sha256: contractHash, spec_sha256: contractHash }),
  ]);
  const version = await runAndRecord('verus', ['--version'], directory, 'verus-version', 10_000);
  let native;
  if (exitedSuccessfully(version)) {
    native = await runAndRecord('verus', [
      sourcePath, '--no-cheating', '--compile', '--num-threads', '1', '--rlimit', '10',
      '--crate-name', 'veri_watch_kernel', '--log-dir', join(directory, 'verus-log'), '-o', binaryPath,
    ], directory, 'verify', BUILD_TIMEOUT_MS);
  }
  const output = native ?? version;
  const counts = native && /verification results::\s*(\d+) verified,\s*(\d+) errors?/.exec(native.stdout + '\n' + native.stderr);
  let binaryHash;
  if (native && exitedSuccessfully(native) && counts && counts[1] === '1' && counts[2] === '0') {
    try { binaryHash = sha256(await readFile(binaryPath)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const success = Boolean(binaryHash);
  const error = success ? undefined
    : output.error ?? (output.timed_out ? 'Native verification/compilation timed out'
      : output.output_limited ? 'Native output exceeded the capture limit'
        : !native ? 'Could not obtain the Verus version; install Verus 0.2026.09.08.67038a4 and Rust 1.98.1 on PATH'
          : 'Native verification/compilation failed; inspect verify.stdout.txt and verify.stderr.txt');
  const build = {
    success, verified: Boolean(counts && counts[1] === '1' && counts[2] === '0'),
    verified_count: counts ? Number(counts[1]) : null, errors: counts ? Number(counts[2]) : null,
    duration_ms: Number((performance.now() - started).toFixed(3)),
    stdout: output.stdout, stderr: output.stderr,
    source_sha256: sourceHash, contract_sha256: contractHash,
    ...(binaryHash ? { binary_sha256: binaryHash } : {}),
    artifact_dir: directory, source, variant, activated: false,
    verus_version: exitedSuccessfully(version) ? version.stdout.trim() : null,
    ...(error ? { error } : {}),
  };
  await Promise.all([
    writeJSON(join(directory, 'status.json'), build),
    writeJSON(join(directory, 'hashes.json'), {
      source_sha256: sourceHash, contract_sha256: contractHash, spec_sha256: contractHash,
      ...(binaryHash ? { binary_sha256: binaryHash } : {}),
    }),
  ]);
  return build;
}

async function activate(build) {
  if (!build.success || !build.binary_sha256 || build.verified !== true
      || build.verified_count !== 1 || build.errors !== 0) {
    throw new Error('Only an exactly verified and compiled kernel may be activated');
  }
  const next = { ...build, activated: true };
  const temporary = join(ROOT, `active-${randomUUID()}.json`);
  try {
    await writeJSON(temporary, next);
    await rename(temporary, ACTIVE_PATH);
  } finally { await rm(temporary, { force: true }); }
  await writeJSON(join(build.artifact_dir, 'status.json'), next);
  return next;
}

function ensureBuild() {
  if (ensureInFlight) return ensureInFlight;
  const task = serializeBuild(async () => {
    const existing = await loadActive();
    if (existing) return existing;
    const original = await buildVariant('original');
    return original.success ? activate(original) : original;
  });
  ensureInFlight = task;
  const clear = () => { if (ensureInFlight === task) ensureInFlight = undefined; };
  task.then(clear, clear);
  return task;
}

export async function ensureKernel() {
  try { return publicStatus(await ensureBuild()); }
  catch (error) { return { ready: false, status: 'error', error: error.message }; }
}

export async function evaluateGuard(input) {
  objectWithKeys(input, ['variant', 'activate'], 'guard evaluation');
  if (!CANDIDATE_VARIANTS.includes(input.variant)) throw new TypeError(`variant must be one of: ${CANDIDATE_VARIANTS.join(', ')}`);
  if (input.activate !== undefined && typeof input.activate !== 'boolean') throw new TypeError('activate must be boolean');
  // Snapshot all caller input before awaiting the queue.
  const { variant, activate: shouldActivate = false } = input;
  return serializeBuild(async () => {
    const build = await buildVariant(variant);
    return build.success && shouldActivate ? activate(build) : build;
  });
}

export async function runTransition(input) {
  // Shape/range checks only. Semantic rejection belongs exclusively to compact.
  const request = normalizeInput(input);
  const build = await ensureBuild();
  if (!build.success) throw new Error(`Kernel unavailable: ${build.error}`);
  const directory = await mkdtemp(join(ROOT, 'transition-'));
  await writeJSON(join(directory, 'request.json'), {
    ...request,
    kernel: publicStatus(build),
  });
  const native = await runAndRecord(join(build.artifact_dir, 'kernel-native'), [
    request.revision, request.base_revision,
    request.masks.retained, request.masks.required, request.masks.proposed,
  ], directory, 'native', NATIVE_TIMEOUT_MS);
  try {
    if (!exitedSuccessfully(native)) throw new Error(`Native kernel failed (exit ${native.exit_code}): ${native.error ?? native.stderr}`);
    const response = JSON.parse(native.stdout);
    objectWithKeys(response, ['revision', 'retained', 'accepted'], 'native response');
    const revision = decimalU64(response.revision, 'native revision');
    if (typeof response.accepted !== 'boolean') throw new TypeError('Native accepted must be boolean');
    const result = {
      revision, retained_ids: maskToIds(response.retained), accepted: response.accepted,
      duration_ms: native.duration_ms, stdout: native.stdout, binary_sha256: build.binary_sha256,
    };
    await writeJSON(join(directory, 'result.json'), result);
    return result;
  } catch (error) {
    await writeJSON(join(directory, 'error.json'), { error: error.message });
    throw new Error(`${error.message} (evidence: ${directory})`, { cause: error });
  }
}
