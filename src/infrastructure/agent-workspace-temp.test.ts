import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentWorkspaceTempDirectoryFor,
  createAgentExecutionTempDirectory,
  createAgentWorkspaceTempDirectory,
  removeAgentWorkspaceTempDirectory,
} from './agent-workspace-temp';

test('creates one Loop-owned directory under the workspace .tmp folder', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-'));
  try {
    const temporary = createAgentWorkspaceTempDirectory(workspace, 'RUN-123');
    assert.equal(temporary.root, join(workspace, '.tmp'));
    assert.equal(temporary.directory, join(workspace, '.tmp', 'loop-RUN-123'));
    assert.equal(existsSync(temporary.directory), true);
    const agentDirectory = createAgentExecutionTempDirectory(temporary, 'EXEC-123');
    assert.equal(agentDirectory, join(temporary.directory, 'agent-EXEC-123'));
    writeFileSync(join(agentDirectory, 'statement.md'), 'long command input', 'utf8');

    assert.deepEqual(removeAgentWorkspaceTempDirectory(temporary), { ok: true });
    assert.equal(existsSync(temporary.directory), false);
    assert.equal(existsSync(temporary.root), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cleanup preserves files and concurrent Loop directories it does not own', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-shared-'));
  try {
    const first = createAgentWorkspaceTempDirectory(workspace, 'RUN-A');
    const second = createAgentWorkspaceTempDirectory(workspace, 'RUN-B');
    const retained = join(workspace, '.tmp', 'user-owned.txt');
    writeFileSync(retained, 'preserve', 'utf8');
    mkdirSync(second.directory, { recursive: true });

    assert.deepEqual(removeAgentWorkspaceTempDirectory(first), { ok: true });
    assert.equal(existsSync(first.directory), false);
    assert.equal(existsSync(second.directory), true);
    assert.equal(existsSync(retained), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('restarting a Runner for the same Loop preserves temporary files until the Loop ends', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-resume-'));
  try {
    const first = createAgentWorkspaceTempDirectory(workspace, 'RUN-resume');
    const marker = join(first.directory, 'keep-across-runner-handoff.txt');
    writeFileSync(marker, 'preserve until Loop ends', 'utf8');

    const resumed = createAgentWorkspaceTempDirectory(workspace, 'RUN-resume');
    assert.deepEqual(resumed, agentWorkspaceTempDirectoryFor(workspace, 'RUN-resume'));
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rejects run ids that could escape the run-owned directory', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-invalid-'));
  try {
    assert.throws(
      () => createAgentWorkspaceTempDirectory(workspace, '../outside'),
      /不能用于临时目录/,
    );
    const temporary = createAgentWorkspaceTempDirectory(workspace, 'RUN-valid');
    assert.throws(
      () => createAgentExecutionTempDirectory(temporary, '../outside'),
      /不能用于临时目录/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
