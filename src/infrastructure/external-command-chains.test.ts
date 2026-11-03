import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfiguredWorkspaceRoot } from './database';
import { loadAgentCommandScript, loadExternalCommandChains } from './external-command-chains';
import { loadCommandChainDefinition } from '../domain/command-chain-definition';
import { getAgentCommandFile } from '../application/agent-configurations';
import { commandChainHelp } from '../application/command-chain-drafts';

const workspace = getConfiguredWorkspaceRoot();
const dev = readFileSync(join(workspace, '.omp', 'commands', 'dev-agent.cjs'), 'utf8');

test('discovers executable workspace scripts without YAML or installation fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'external script '));
  const previous = process.env.LOOP_WORKSPACE_ROOT_OVERRIDE;
  mkdirSync(join(root, '.omp', 'commands'), { recursive: true });
  cpSync(join(workspace, '.omp', 'commands', 'workflow'), join(root, '.omp', 'commands', 'workflow'), { recursive: true });
  process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = root;
  try {
    writeFileSync(join(root, '.omp', 'commands', 'dev-agent.yaml'), 'legacy definitions are ignored');
    assert.throws(() => loadCommandChainDefinition('development'), /命令脚本不存在/);
    assert.match(getAgentCommandFile('dev-agent').error!, /dev-agent.cjs/);
    writeFileSync(join(root, '.omp', 'commands', 'dev-agent.cjs'), dev.replace('"version": 1', '"version": 12'));
    assert.equal(loadCommandChainDefinition('development').version, 12);
    assert.equal(getAgentCommandFile('dev-agent').files.length, 3);
    assert.throws(() => loadAgentCommandScript(root, '../dev-agent'), /未知 Agent/);
    rmSync(join(root, '.omp', 'commands', 'dev-agent.cjs'));
    assert.throws(() => loadCommandChainDefinition('development'), /命令脚本不存在/);
  } finally {
    process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforces the scheduler interface and binds both feedback pipelines from executable describe', () => {
  const path = join(workspace, '.omp', 'commands', 'dev-agent.cjs');
  try {
    writeFileSync(path, dev.replace('apiVersion: 1', 'apiVersion: 2'));
    assert.throws(() => loadAgentCommandScript(workspace, 'dev-agent'), /apiVersion 必须是 1/);
    writeFileSync(path, dev.replace('agent: "dev-agent"', 'agent: "test-agent"'));
    assert.throws(() => loadAgentCommandScript(workspace, 'dev-agent'), /必须绑定 Agent/);
    writeFileSync(path, dev.replace('execute(runtime, invocation)', 'missingExecute(runtime, invocation)'));
    assert.throws(() => loadAgentCommandScript(workspace, 'dev-agent'), /缺少接口：execute/);
    writeFileSync(path, dev.replace('execute(runtime, invocation)', 'async execute(runtime, invocation)'));
    assert.throws(() => loadAgentCommandScript(workspace, 'dev-agent'), /必须使用同步接口/);
  } finally { writeFileSync(path, dev); }

  const feedbackPath = join(workspace, '.omp', 'commands', 'feedback-agent.cjs');
  const feedback = readFileSync(feedbackPath, 'utf8');
  try {
    assert.deepEqual(loadExternalCommandChains(workspace, 'feedback-agent').documents.map(doc => doc.commandChainId),
      ['feedback-triage', 'feedback-verify']);
    writeFileSync(feedbackPath, feedback + '\nconst original = module.exports.describe; module.exports.describe = host => original(host).slice(0, 1);\n');
    assert.throws(() => loadExternalCommandChains(workspace, 'feedback-agent'), /缺少命令链 feedback-verify/);
    writeFileSync(feedbackPath, feedback + '\nconst original = module.exports.describe; module.exports.describe = host => {const chains = original(host); return [...chains, chains[0]];};\n');
    assert.throws(() => loadExternalCommandChains(workspace, 'feedback-agent'), /ID 重复/);
  } finally { writeFileSync(feedbackPath, feedback); }
});

test('reloads executable shared implementation changes instead of only re-reading configuration', () => {
  const path = join(workspace, '.omp', 'commands', 'workflow', 'command-chain-runtime.cjs');
  const original = readFileSync(path, 'utf8');
  try {
    assert.doesNotMatch(commandChainHelp('dev-agent'), /EXTERNAL_RUNTIME_PROOF/);
    writeFileSync(path, original.replace('通用命令链不绑定 Agent namespace', 'EXTERNAL_RUNTIME_PROOF'));
    assert.match(commandChainHelp('dev-agent'), /EXTERNAL_RUNTIME_PROOF/);
  } finally { writeFileSync(path, original); }
});
