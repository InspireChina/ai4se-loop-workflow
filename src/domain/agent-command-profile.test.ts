import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCommandPrompt,
  agentCommandProfiles,
  agentContextHelpLines,
} from './agent-command-profile';

test('injects the complete read-only context and submission contract before Agent work', () => {
  const prompt = agentCommandPrompt('/opt/Loop Work', 'analyst-agent', 'analysis');
  assert.ok(prompt);
  assert.match(prompt, /# Agent Tool Contract/);
  assert.match(prompt, /loop-agent\.mjs" status/);
  assert.match(prompt, /agent-context overview/);
  assert.match(prompt, /agent-context list/);
  assert.match(prompt, /agent-context get/);
  assert.match(prompt, /agent-context search/);
  assert.match(prompt, /agent-context evidence/);
  assert.match(prompt, /agent-context history/);
  assert.match(prompt, /通用命令链/);
  assert.match(prompt, /Artifact、Decision 和 Phase/);
  assert.match(prompt, /loop-agent\.mjs" help/);
  assert.match(prompt, /phase complete/);
  assert.match(prompt, /\*\*首次必须执行：\*\*\n```bash/);
  assert.match(prompt, /- `npm --prefix/);
  assert.match(prompt, /\$LOOP_AGENT_TMP_DIR/);
  assert.doesNotMatch(prompt, /## 工具选择顺序|## 命令行为/);
  assert.doesNotMatch(prompt, /implementation complete/);
});

test('every configured role chain renders all terminal actions and forbids intermediate exit', () => {
  for (const profile of agentCommandProfiles()) {
    assert.ok(profile.terminalActions.length > 0, `${profile.id} has no terminal action`);
    for (const pipeline of profile.pipelines) {
      const prompt = agentCommandPrompt('/app', profile.agent, pipeline);
      assert.ok(prompt, `${profile.agent}/${pipeline} has no command prompt`);
      for (const action of profile.terminalActions) {
        assert.match(prompt, new RegExp(action.split(' --')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      assert.match(prompt, /CLI exit 0/);
      assert.match(prompt, /只有.*(?:submit|phase complete|终止命令).*才能结束 execution|不能在角色终止命令成功前主动结束 execution/);
    }
  }
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
  const direct = agentCommandPrompt('/app', 'direct-agent', 'direct');
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
  assert.match(direct || '', /direct run/);
  assert.match(direct || '', /direct submit/);
  assert.doesNotMatch(direct || '', /direct status|needs_input|request-input/);
  assert.match(backlog || '', /通用命令链/);
  assert.match(backlog || '', /phase complete/);
  assert.match(backlog || '', /phase rewind --to <earlier-phase>/);
  assert.match(splitter || '', /通用命令链/);
  assert.match(splitter || '', /phase complete/);
  assert.match(splitter || '', /phase rewind --to <earlier-phase>/);
  assert.match(analyst || '', /通用命令链/);
  assert.match(analyst || '', /phase complete/);
  assert.match(analyst || '', /phase rewind --to <earlier-phase>/);
  assert.match(development || '', /通用命令链/);
  assert.match(development || '', /phase complete/);
  assert.match(development || '', /phase rewind --to <earlier-phase>/);
  assert.match(verification || '', /通用命令链/);
  assert.match(verification || '', /phase complete/);
  assert.match(verification || '', /phase rewind --to <earlier-phase>/);
  assert.match(review || '', /通用命令链/);
  assert.match(review || '', /phase complete/);
  assert.match(review || '', /phase rewind --to <earlier-phase>/);
  for (const prompt of [ideaContext, businessDesign, requirementSpec, specReview]) {
    assert.match(prompt || '', /help <context\|workflow\|artifact\|decision\|finish>/);
    assert.match(prompt || '', /命令统一返回 `COMMAND RESULT`/);
  }
  assert.match(ideaContext || '', /idea-context request-clarification/);
  assert.match(businessDesign || '', /business-design request-clarification/);
  assert.match(requirementSpec || '', /requirement-spec return-gap/);
  assert.match(specReview || '', /spec-review approve/);
  assert.doesNotMatch(review || '', /review request-input/);
  assert.doesNotMatch(verification || '', /verification (?:complete|request-input|pass|fail|block)/);
  assert.doesNotMatch(development || '', /help <[^>]*handoff/);
  assert.doesNotMatch(development || '', /implementation fail --reason <原因与证据>/);
  assert.doesNotMatch(analyst || '', /--reason <原因与证据>/);
  for (const prompt of [direct, ideaContext, businessDesign, requirementSpec, specReview]) {
    assert.doesNotMatch(prompt || '', /loop-agent\.mjs" help\n/);
  }
  assert.match(analyst || '', /loop-agent\.mjs" help\n/);
  assert.match(backlog || '', /loop-agent\.mjs" help\n/);
  assert.match(splitter || '', /loop-agent\.mjs" help\n/);
  assert.match(development || '', /loop-agent\.mjs" help\n/);
  assert.match(verification || '', /loop-agent\.mjs" help\n/);
  assert.match(review || '', /loop-agent\.mjs" help\n/);
});
