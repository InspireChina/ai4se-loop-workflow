import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/workflow/run-check.mjs');

test('workspace check preserves command arguments, streams and failed exit codes without overwriting runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow check '));
  try {
    for (const exitCode of [0, 7]) {
      const child = spawnSync(process.execPath, [script, '--output', root, '--', process.execPath,
        '-e', 'console.log(process.argv[1]); console.error("check stderr"); process.exit(Number(process.argv[2]));',
        'spaces; $(not-a-shell) "quoted"', String(exitCode)], { encoding: 'utf8' });
      assert.equal(child.status, exitCode, child.stderr);
      assert.match(child.stdout, /spaces; \$\(not-a-shell\) "quoted"/);
      assert.match(child.stderr, /check stderr/);
    }
    const directories = readdirSync(root);
    assert.equal(directories.length, 2);
    const codes = directories.map((directory) => {
      const path = join(root, directory);
      const result = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8'));
      assert.equal(result.command.at(-2), 'spaces; $(not-a-shell) "quoted"');
      assert.equal(result.cwd, process.cwd());
      assert.equal(result.signal, null);
      assert.equal(result.error, null);
      assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /not-a-shell/);
      assert.equal(readFileSync(join(path, 'stderr.log'), 'utf8'), 'check stderr\n');
      return result.exitCode;
    });
    assert.deepEqual(codes.sort((a, b) => a - b), [0, 7]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing programs leave failure evidence and missing arguments run nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-check-'));
  try {
    const invalid = spawnSync(process.execPath, [script, '--output', root, '--'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.deepEqual(readdirSync(root), []);
    const missing = spawnSync(process.execPath, [script, '--output', root, '--', join(root, 'missing-command')], { encoding: 'utf8' });
    assert.equal(missing.status, 1, missing.stderr);
    const [directory] = readdirSync(root);
    const result = JSON.parse(readFileSync(join(root, directory, 'result.json'), 'utf8'));
    assert.equal(result.exitCode, 1);
    assert.match(result.error, /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancelling a running check records interruption as failure', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-check-stop-'));
  const child = spawn(process.execPath, [script, '--output', root, '--', process.execPath,
    '-e', 'setInterval(() => {}, 1000); console.log("ready");'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 143);
    const [directory] = readdirSync(root);
    const result = JSON.parse(readFileSync(join(root, directory, 'result.json'), 'utf8'));
    assert.equal(result.exitCode, 143);
    assert.equal(result.signal, 'SIGTERM');
    assert.match(readFileSync(join(root, directory, 'stdout.log'), 'utf8'), /ready/);
  } finally {
    child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
