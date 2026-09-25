import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from './checks.mjs';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const experimentRoot = join(repositoryRoot, 'target', 'tmp', 'experiments');
export const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2);

export async function createArtifacts(label = 'run') {
  await mkdir(experimentRoot, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const directory = await mkdtemp(join(experimentRoot, `${stamp}-${label}-`));
  let sequence = 0;
  return {
    directory,
    async write(name, value) {
      await writeFile(join(directory, name), `${json(value)}\n`, { flag: 'w' });
    },
    async outcome(value) {
      await appendFile(join(directory, 'outcomes.jsonl'), `${JSON.stringify({ sequence: sequence++, ...value })}\n`);
    },
  };
}

export async function treeHashes(directory, prefix = '') {
  const hashes = {};
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return hashes; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await treeHashes(join(directory, entry.name), name));
    else if (entry.isFile()) hashes[name] = sha256(await readFile(join(directory, entry.name)));
  }
  return hashes;
}

export async function sourceIdentities() {
  const sources = {};
  for (const directory of ['kernel', 'lib', 'integrations', 'experiments', 'tests']) {
    for (const [path, hash] of Object.entries(await treeHashes(join(repositoryRoot, directory)))) {
      sources[join(directory, path)] = hash;
    }
  }
  for (const path of ['docs/CONTRACT.md', 'package.json']) {
    sources[path] = sha256(await readFile(join(repositoryRoot, path)));
  }
  let commit = null;
  let gitStatus = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    gitStatus = execFileSync('git', ['status', '--short'], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { /* An uncommitted new checkout is still identified by source hashes. */ }
  return { commit, git_status: gitStatus, sources };
}

export function errorRecord(error) {
  return {
    name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code ?? null, stack: error?.stack ?? null,
    ...Object.fromEntries(['provider', 'status', 'evidence_path', 'input_tokens', 'output_tokens']
      .filter(key => error?.[key] !== undefined).map(key => [key, error[key]])),
  };
}

export function relativeArtifact(path) {
  return relative(repositoryRoot, path);
}

// Preserve the provider's raw success AND failure exchanges, not only proposals.
export async function providerEvidence(...values) {
  const captured = {};
  const seen = new Set();
  const visit = async value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidence_path' && typeof child === 'string') {
        const path = resolve(repositoryRoot, child);
        const relativePath = relative(join(repositoryRoot, 'target', 'tmp'), path);
        if (relativePath.startsWith('..') || isAbsolute(relativePath) || Object.hasOwn(captured, path)) continue;
        captured[path] = null;
        try {
          captured[path] = JSON.parse(await readFile(path, 'utf8'));
          await visit(captured[path]);
        } catch (error) { captured[path] = { capture_error: errorRecord(error) }; }
      } else await visit(child);
    }
  };
  for (const value of values) await visit(value);
  return captured;
}

export function modelExchangeCounts(providerFiles) {
  // The provider records one exchange per actual fetch invocation; no inference
  // from an engine action, health check, or locally injected transition.
  let requests = 0;
  let responses = 0;
  for (const evidence of Object.values(providerFiles)) {
    if (evidence?.provider !== 'liquid' || !Array.isArray(evidence.exchanges)) continue;
    for (const exchange of evidence.exchanges) {
      if (!Array.isArray(exchange.request?.body?.messages)) continue;
      requests++;
      if (Object.hasOwn(exchange, 'response_raw')) responses++;
    }
  }
  return { requests, responses };
}
