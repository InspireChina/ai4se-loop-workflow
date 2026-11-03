import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { buildAgentConfigurationChatPrompt, extractAgentConfigurationScript, validateAgentConfigurationChatOutput } from './agent-configuration-chat';

const content = readFileSync(join(getConfiguredWorkspaceRoot(), '.omp', 'commands', 'backlog-agent.cjs'), 'utf8');
const fence = String.fromCharCode(96).repeat(3);

test('injects versioned interfaces and original source into script editing Chat', () => {
  const prompt = buildAgentConfigurationChatPrompt({
    agentId: 'backlog-agent', relativePath: 'backlog-agent.cjs', content, message: '增加一个最终确认提醒',
  });
  assert.match(prompt, /apiVersion/);
  assert.match(prompt, /initialize.*execute.*restore/);
  assert.match(prompt, /当前完整脚本/);
  assert.match(prompt, /增加一个最终确认提醒/);
});

test('extracts complete JavaScript without evaluating model-generated drafts', () => {
  const output = '已补充注释。\n\n' + fence + 'javascript\n' + content.trim() + '\n' + fence + '\n';
  assert.match(extractAgentConfigurationScript(output), /module\.exports/);
  const result = validateAgentConfigurationChatOutput('backlog-agent', output);
  assert.equal(result.explanation, '已补充注释。');
  assert.match(result.content, /backlog-agent/);
  assert.throws(() => validateAgentConfigurationChatOutput('backlog-agent', fence + 'js\nmodule.exports = {\n' + fence + '\n'), SyntaxError);
  assert.throws(() => extractAgentConfigurationScript('只改这一行'), /未返回完整 JavaScript/);
});
