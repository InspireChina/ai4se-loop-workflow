import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentExecutionTempDirectoryFor,
  createAgentExecutionTempDirectory,
  removeAgentExecutionTempDirectory,
} from './agent-workspace-temp';

test('creates one execution-owned directory directly under the workspace .tmp folder', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-'));
  try {
    const temporary = createAgentExecutionTempDirectory(workspace, 'EXEC-123');
    assert.equal(temporary.root, join(workspace, '.tmp'));
    assert.equal(temporary.directory, join(workspace, '.tmp', 'agent-EXEC-123'));
    assert.equal(existsSync(temporary.directory), true);
    writeFileSync(join(temporary.directory, 'statement.md'), 'long command input', 'utf8');

    assert.deepEqual(removeAgentExecutionTempDirectory(temporary), { ok: true });
    assert.equal(existsSync(temporary.directory), false);
    assert.equal(existsSync(temporary.root), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cleanup preserves files and concurrent Loop directories it does not own', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-shared-'));
  try {
    const first = createAgentExecutionTempDirectory(workspace, 'EXEC-A');
    const second = createAgentExecutionTempDirectory(workspace, 'EXEC-B');
    const retained = join(workspace, '.tmp', 'user-owned.txt');
    writeFileSync(retained, 'preserve', 'utf8');
    mkdirSync(second.directory, { recursive: true });

    assert.deepEqual(removeAgentExecutionTempDirectory(first), { ok: true });
    assert.equal(existsSync(first.directory), false);
    assert.equal(existsSync(second.directory), true);
    assert.equal(existsSync(retained), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('opening the same execution-owned directory does not erase files before explicit cleanup', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-resume-'));
  try {
    const first = createAgentExecutionTempDirectory(workspace, 'EXEC-resume');
    const marker = join(first.directory, 'keep-until-execution-cleanup.txt');
    writeFileSync(marker, 'preserve until explicit cleanup', 'utf8');

    const resumed = createAgentExecutionTempDirectory(workspace, 'EXEC-resume');
    assert.deepEqual(resumed, agentExecutionTempDirectoryFor(workspace, 'EXEC-resume'));
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rejects execution ids that could escape the workspace temporary directory', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-agent-temp-invalid-'));
  try {
    assert.throws(
      () => createAgentExecutionTempDirectory(workspace, '../outside'),
      /不能用于临时目录/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
