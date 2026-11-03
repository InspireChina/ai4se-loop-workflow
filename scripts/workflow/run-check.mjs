#!/usr/bin/env node
// A workspace helper, independent of the Workflow database and command protocol.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:os';

const usage = 'Usage: node scripts/workflow/run-check.mjs --output <folder> -- <program> [args...]';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
} else if (args[0] !== '--output' || !args[1] || args[2] !== '--' || !args[3]) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    await run(args[1], args.slice(3));
  } catch (error) {
    console.error(`run-check: ${error.message}`);
    process.exitCode = 1;
  }
}

async function run(output, command) {
  const root = resolve(output);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, 'check-'));
  const stdout = createWriteStream(join(directory, 'stdout.log'), { mode: 0o600 });
  const stderr = createWriteStream(join(directory, 'stderr.log'), { mode: 0o600 });
  // Attach rejection handlers before spawning, including when the output disk fails.
  const logs = Promise.allSettled([finished(stdout), finished(stderr)]);
  const startedAt = new Date().toISOString();
  const grouped = process.platform !== 'win32';
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(), env: process.env, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], detached: grouped, windowsHide: true,
  });
  let error;
  let interrupted;
  let killTimer;
  const kill = (signal) => {
    try {
      if (child.pid && grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (failure) {
      if (failure.code !== 'ESRCH') error ||= failure.message;
    }
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      interrupted ||= signal;
      kill(signal);
      killTimer ||= setTimeout(() => kill('SIGKILL'), 3000);
    };
    process.on(signal, handler);
    return [signal, handler];
  }));
  for (const stream of [stdout, stderr]) stream.on('error', (failure) => {
    error ||= failure.message;
    kill('SIGKILL');
  });
  child.stdout.pipe(stdout);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(stderr);
  child.stderr.pipe(process.stderr, { end: false });
  child.on('error', (failure) => { error ||= failure.message; });
  const { code, signal } = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killTimer);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  const logResults = await logs;
  const logFailure = logResults.find((result) => result.status === 'rejected');
  if (logFailure) error ||= String(logFailure.reason);
  const endedBy = interrupted || signal;
  const exitCode = endedBy ? 128 + (constants.signals[endedBy] || 1) : error ? 1 : code ?? 1;
  const result = { command, cwd: process.cwd(), startedAt, finishedAt: new Date().toISOString(),
    exitCode, signal: endedBy || null, error: error || null };
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.error(`\nCheck result: ${join(directory, 'result.json')}`);
  process.exitCode = exitCode;
}
