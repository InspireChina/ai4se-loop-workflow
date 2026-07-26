import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCommandPrompt,
  agentContextHelpLines,
} from './agent-command-profile';

test('injects the complete read-only context tool list and usage order before Agent work', () => {
  const prompt = agentCommandPrompt('/opt/Loop Work', 'analyst-agent', 'analysis');
  assert.ok(prompt);
  assert.match(prompt, /# Agent Tool Contract/);
  assert.match(prompt, /delivery-analysis status/);
  assert.match(prompt, /agent-context overview/);
  assert.match(prompt, /agent-context list/);
  assert.match(prompt, /agent-context get/);
  assert.match(prompt, /agent-context search/);
  assert.match(prompt, /agent-context evidence/);
  assert.match(prompt, /agent-context history/);
  assert.match(prompt, /required context refs/);
  assert.match(prompt, /实时 Ground Truth/);
  assert.match(prompt, /只有完成上述调查后仍无法从现有证据唯一确定/);
  assert.match(prompt, /help <context\|impact\|decision\|contract\|finish>/);
  assert.match(prompt, /delivery-analysis complete/);
  assert.doesNotMatch(prompt, /implementation complete/);
});

test('shares one context command guide with prompt and help surfaces', () => {
  const lines = agentContextHelpLines('C:\\Loop Work');
  const content = lines.join('\n');
  assert.match(content, /agent-context overview/);
  assert.match(content, /不知道准确 ref 时使用/);
  assert.match(content, /Prompt 给出 required refs 时优先使用/);
  assert.match(content, /仅在资料存在版本、替代或冲突疑问时检查历史/);
});

test('advertises a role-specific command guide for every progressive flow Agent', () => {
  const backlog = agentCommandPrompt('/app', 'backlog-agent', 'backlog');
  const splitter = agentCommandPrompt('/app', 'story-splitter-agent', 'split');
  const analyst = agentCommandPrompt('/app', 'analyst-agent', 'analysis');
  const development = agentCommandPrompt('/app', 'dev-agent', 'dev');
  const verification = agentCommandPrompt('/app', 'test-agent', 'test');
  const review = agentCommandPrompt('/app', 'review-agent', 'review');
  assert.match(backlog || '', /help <context\|assertion\|impact\|question\|scope\|finish>/);
  assert.match(splitter || '', /help <context\|unit\|source\|dependency\|revision\|finish>/);
  assert.match(analyst || '', /help <context\|impact\|decision\|contract\|finish>/);
  assert.match(development || '', /help <context\|evidence\|input\|finish>/);
  assert.match(verification || '', /help <context\|plan\|execute\|input\|finish>/);
  assert.match(review || '', /help <context\|reconciliation\|gap\|report\|finish>/);
  assert.match(review || '', /Review 不创建问题或运行信息请求/);
  assert.match(review || '', /review complete/);
  assert.doesNotMatch(review || '', /review request-input/);
  assert.match(verification || '', /verification complete/);
  assert.match(verification || '', /verification request-input/);
  assert.doesNotMatch(verification || '', /verification (?:pass|fail|block)/);
  assert.doesNotMatch(development || '', /help <[^>]*handoff/);
  assert.match(development || '', /implementation fail --reason <原因与证据>/);
  assert.doesNotMatch(analyst || '', /--reason <原因与证据>/);
});
