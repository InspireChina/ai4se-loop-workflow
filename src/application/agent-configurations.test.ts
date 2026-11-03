import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { appDatabaseConnection } from '../infrastructure/database';
import { agentCommandChains } from '../domain/agent-command-profile';
import { loadCommandChainDefinition } from '../domain/command-chain-definition';
import { getAgentCommandFile, saveAgentCommandScript, validateAgentCommandFile } from './agent-configurations';

test('discovers source and runtime files without database configuration and reloads executable metadata', () => {
  const source = getAgentCommandFile('backlog-agent');
  assert.equal(source.error, null);
  assert.match(source.path, /\.omp\/commands\/backlog-agent\.cjs$/);
  assert.ok(source.files.some(file => file.relativePath === 'workflow/command-chain-runtime.cjs'));
  const original = readFileSync(source.path, 'utf8');
  try {
    writeFileSync(source.path, original.replace('"version": 1', '"version": 9'));
    assert.equal(loadCommandChainDefinition('requirement-context').version, 9);
    assert.notEqual(getAgentCommandFile('backlog-agent').hash, source.hash);
  } finally { writeFileSync(source.path, original); }
  const db = appDatabaseConnection();
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_configuration_documents'").get(), undefined);
});

test('projects invalid script errors without crashing Agent pages and retains original gates', () => {
  const source = getAgentCommandFile('backlog-agent');
  const original = readFileSync(source.path, 'utf8');
  try {
    writeFileSync(source.path, original.replace('"title": "业务变化上下文",', ''));
    assert.match(getAgentCommandFile('backlog-agent').error || '', /artifacts\.requirement-context\.title/);
    const [projected] = agentCommandChains('backlog-agent');
    assert.equal(projected.phases.length, 0);
    assert.match(projected.configurationError || '', /artifacts\.requirement-context\.title/);
    assert.throws(() => loadCommandChainDefinition('requirement-context'), /artifacts\.requirement-context\.title/);
  } finally { writeFileSync(source.path, original); }
});

test('edits actual source atomically and rejects invalid syntax, stale saves and unrelated paths', () => {
  const source = getAgentCommandFile('dev-agent');
  const file = source.files.find(file => file.relativePath === 'dev-agent.cjs')!;
  try {
    assert.throws(() => saveAgentCommandScript('dev-agent', { relativePath: file.relativePath, expectedHash: file.hash, content: 'module.exports = {' }), SyntaxError);
    assert.equal(readFileSync(file.path, 'utf8'), file.content);
    const updated = saveAgentCommandScript('dev-agent', { relativePath: file.relativePath, expectedHash: file.hash, content: file.content + '\n// source edit proof\n' });
    assert.equal(updated.error, null);
    assert.match(readFileSync(file.path, 'utf8'), /source edit proof/);
    assert.throws(() => saveAgentCommandScript('dev-agent', { relativePath: file.relativePath, expectedHash: file.hash, content: file.content }), /其他编辑/);
    assert.throws(() => saveAgentCommandScript('dev-agent', { relativePath: '../outside.cjs', expectedHash: file.hash, content: file.content }), /不属于/);
    assert.throws(() => saveAgentCommandScript('dev-agent', { relativePath: 'test-agent.cjs', expectedHash: file.hash, content: file.content }), /不属于/);
    validateAgentCommandFile('dev-agent', 'globalThis.__loopworkSyntaxExecuted = true;');
    assert.equal((globalThis as Record<string, unknown>).__loopworkSyntaxExecuted, undefined);
  } finally { writeFileSync(file.path, file.content); }
});

test('direct execution also exposes its real implementation while preserving its two-step protocol', () => {
  const source = getAgentCommandFile('direct-agent');
  assert.equal(source.error, null);
  assert.ok(source.files.some(file => file.relativePath === 'direct-agent.cjs'));
  assert.ok(source.files.some(file => file.relativePath === 'workflow/direct-runtime.cjs'));
  assert.deepEqual(source.documents, []);
  assert.deepEqual(agentCommandChains('direct-agent')[0].phases.map(phase => phase.id), ['direct']);
});
