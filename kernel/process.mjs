import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const ROOT = fileURLToPath(new URL('../target/tmp/kernel/', import.meta.url));
export const TMPDIR = join(ROOT, 'tmp');
export const BUILD_TIMEOUT_MS = 120_000;
export const NATIVE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function prepareDirectories() {
  await mkdir(TMPDIR, { recursive: true });
}

export async function writeJSON(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

// No shell; no caller-controlled flags. Kill the entire compiler process group
// on timeout so a timed-out rustc/solver cannot outlive its build lock.
export async function runAndRecord(command, args, directory, name, timeoutMs) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const environment = { TMPDIR, TMP: TMPDIR, TEMP: TMPDIR, RUSTUP_TOOLCHAIN: '1.98.1' };
  await writeJSON(join(directory, `${name}.command.json`), {
    command, args, cwd: directory, environment, timeout_ms: timeoutMs,
  });
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let error;
    let timedOut = false;
    let outputLimited = false;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    function kill() {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (cause) {
        if (cause.code !== 'ESRCH') error = cause.message;
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    function capture(chunks, chunk) {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { outputLimited = true; kill(); }
    }
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.on('error', (cause) => { error = cause.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command, args, started_at: startedAt,
        duration_ms: Number((performance.now() - started).toFixed(3)),
        exit_code: code, signal, timed_out: timedOut, output_limited: outputLimited,
        ...(error ? { error } : {}),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
  const { stdout, stderr, ...status } = result;
  await Promise.all([
    writeFile(join(directory, `${name}.stdout.txt`), stdout),
    writeFile(join(directory, `${name}.stderr.txt`), stderr),
    writeJSON(join(directory, `${name}.status.json`), status),
  ]);
  return result;
}

export function exitedSuccessfully(result) {
  return result.exit_code === 0 && !result.error && !result.timed_out && !result.output_limited;
}
