import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentConfigurationChatPrompt, extractAgentConfigurationYaml, validateAgentConfigurationChatOutput } from './agent-configuration-chat';

const yaml = readFileSync(join(process.env.LOOP_APP_ROOT || process.cwd(), 'command-chains', 'default', 'backlog-agent.yaml'), 'utf8');

test('injects YAML authoring rules and immutable chain identity into configuration Chat', () => {
  const prompt = buildAgentConfigurationChatPrompt({
    agentId: 'backlog-agent',
    commandChainId: 'requirement-context',
    yaml,
    message: '增加一个最终确认提醒',
  });
  assert.match(prompt, /系统辅助 Agent/);
  assert.match(prompt, /id、agent、必要 builtin/);
  assert.match(prompt, /acceptance-definition/);
  assert.match(prompt, /当前完整 YAML/);
  assert.match(prompt, /增加一个最终确认提醒/);
});

test('extracts and validates the full YAML returned by configuration Chat', () => {
  const output = `已补充注释。\n\n\`\`\`yaml\n${yaml.trim()}\n\`\`\``;
  assert.match(extractAgentConfigurationYaml(output), /id: requirement-context/);
  const result = validateAgentConfigurationChatOutput('requirement-context', output);
  assert.equal(result.explanation, '已补充注释。');
  assert.match(result.yaml, /agent: backlog-agent/);
});

test('rejects a Chat response without a complete YAML block', () => {
  assert.throws(() => extractAgentConfigurationYaml('只改这一行：phase complete'), /未返回完整 YAML/);
});
