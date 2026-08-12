import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCommandPrompt,
  agentContextHelpLines,
} from './agent-command-profile';

test('injects the complete read-only context and submission contract before Agent work', () => {
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
  assert.match(prompt, /Required Context Refs/);
  assert.match(prompt, /实时项目事实（只读调查）/);
  assert.match(prompt, /只有完成冻结上下文读取和实时调查后仍无法从证据唯一确定/);
  assert.match(prompt, /help <context\|impact\|decision-proposal\|decision-resolution\|answer-review\|contract\|finish>/);
  assert.match(prompt, /delivery-analysis complete/);
  assert.match(prompt, /\*\*首次必须执行：\*\*\n\n```bash/);
  assert.match(prompt, /- `npm --prefix/);
  assert.match(prompt, /\*\*编辑与提交规则：\*\*/);
  assert.match(prompt, /\$LOOP_AGENT_TMP_DIR/);
  assert.match(prompt, /当前 execution 结束后 Harness 会清理该目录/);
  assert.doesNotMatch(prompt, /## 工具选择顺序|## 命令行为/);
  assert.doesNotMatch(prompt, /implementation complete/);
});

test('shares one context command guide with prompt and help surfaces', () => {
  const lines = agentContextHelpLines('C:\\Loop Work');
  const content = lines.join('\n');
  assert.match(content, /agent-context overview/);
  assert.match(content, /不知道准确 ref 时使用/);
  assert.match(content, /Prompt 给出 Required Context Refs 时优先使用/);
  assert.match(content, /- `npm --prefix/);
  assert.match(content, /仅在资料存在版本、替代或冲突疑问时检查历史/);
});

test('advertises a role-specific command guide for every progressive flow Agent', () => {
  const backlog = agentCommandPrompt('/app', 'backlog-agent', 'backlog');
  const splitter = agentCommandPrompt('/app', 'story-splitter-agent', 'split');
  const analyst = agentCommandPrompt('/app', 'analyst-agent', 'analysis');
  const development = agentCommandPrompt('/app', 'dev-agent', 'dev');
  const verification = agentCommandPrompt('/app', 'test-agent', 'test');
  const review = agentCommandPrompt('/app', 'review-agent', 'review');
  const ideaContext = agentCommandPrompt('/app', 'idea-context-agent', 'ba-intent');
  const businessDesign = agentCommandPrompt('/app', 'business-design-agent', 'ba-design');
  const requirementSpec = agentCommandPrompt('/app', 'requirement-spec-agent', 'ba-spec');
  const specReview = agentCommandPrompt('/app', 'spec-review-agent', 'ba-review');
  assert.match(backlog || '', /COMMAND RESULT.*NEXT WORK PACKET/);
  assert.match(backlog || '', /help <context\|assertion\|impact\|decision-proposal\|decision-resolution\|answer-review\|scope\|finish>/);
  assert.match(splitter || '', /help <context\|unit\|source\|dependency\|revision\|finish>/);
  assert.match(analyst || '', /help <context\|impact\|decision-proposal\|decision-resolution\|answer-review\|contract\|finish>/);
  assert.match(development || '', /help <context\|evidence\|review\|commit\|input\|finish>/);
  assert.match(development || '', /implementation 命令统一返回 `COMMAND RESULT`/);
  assert.match(verification || '', /help <context\|plan\|execute\|evidence\|input\|finish>/);
  assert.match(verification || '', /verification 命令统一返回 `COMMAND RESULT`/);
  assert.match(review || '', /help <context\|reconciliation\|gap\|assessment\|report\|forward\|finish>/);
  assert.match(review || '', /review 命令统一返回 `COMMAND RESULT`/);
  assert.match(review || '', /Review 不创建问题或运行信息请求/);
  assert.match(review || '', /review complete/);
  for (const prompt of [ideaContext, businessDesign, requirementSpec, specReview]) {
    assert.match(prompt || '', /help <context\|workflow\|artifact\|decision\|finish>/);
    assert.match(prompt || '', /命令统一返回 `COMMAND RESULT`/);
  }
  assert.match(ideaContext || '', /idea-context request-clarification/);
  assert.match(businessDesign || '', /business-design request-clarification/);
  assert.match(requirementSpec || '', /requirement-spec return-gap/);
  assert.match(specReview || '', /spec-review approve/);
  assert.doesNotMatch(review || '', /review request-input/);
  assert.match(verification || '', /verification complete/);
  assert.match(verification || '', /verification request-input/);
  assert.doesNotMatch(verification || '', /verification (?:pass|fail|block)/);
  assert.doesNotMatch(development || '', /help <[^>]*handoff/);
  assert.match(development || '', /implementation fail --reason <原因与证据>/);
  assert.doesNotMatch(analyst || '', /--reason <原因与证据>/);
  for (const prompt of [backlog, splitter, analyst, development, verification, review, ideaContext, businessDesign, requirementSpec, specReview]) {
    assert.doesNotMatch(prompt || '', /loop-agent\.mjs" help\n/);
  }
});
