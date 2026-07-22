import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, FLOW_AGENT_IDS } from './agent-profile';

test('ships rigorous versioned seed prompts for every flow Agent', () => {
  assert.equal(AGENT_PROMPT_SEED_REVISION, 13);
  for (const agentId of FLOW_AGENT_IDS) {
    const prompt = AGENT_PROFILE_DEFINITIONS[agentId].prompt;
    assert.ok(prompt.length >= 450, `${agentId} seed prompt is too small to define a reliable role contract`);
    assert.match(prompt, /# 角色目标/, agentId);
    assert.match(prompt, /# (?:完成条件|判定规则)/, agentId);
    assert.match(prompt, /# (?:决策边界|禁止事项)/, agentId);
  }
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /现有实现已经满足规格/);
  assert.match(AGENT_PROFILE_DEFINITIONS['backlog-agent'].prompt, /目标、范围、路由或交付边界/);
  assert.match(AGENT_PROFILE_DEFINITIONS['backlog-agent'].prompt, /outcome=needs_input/);
  assert.match(AGENT_PROFILE_DEFINITIONS['analyst-agent'].prompt, /完整 decisionTree/);
  assert.match(AGENT_PROFILE_DEFINITIONS['analyst-agent'].prompt, /重大技术决策/);
  assert.match(AGENT_PROFILE_DEFINITIONS['analyst-agent'].prompt, /禁止使用 safe_default/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /不要为了制造 diff/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /工作区已有其他未提交内容不是跳过 commit 的理由/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /成功提交本轮相关改动后才能返回 completed/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /只能暂存本轮相关改动/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /runtimeInputs/);
  assert.match(AGENT_PROFILE_DEFINITIONS['test-agent'].prompt, /runtimeInputs/);
  assert.match(AGENT_PROFILE_DEFINITIONS['review-agent'].prompt, /逐条说明如何处理/);
  assert.match(AGENT_PROFILE_DEFINITIONS['review-agent'].prompt, /反馈的阶段判断和回退路由由 Feedback Agent 与 Harness 负责/);
  assert.match(AGENT_PROFILE_DEFINITIONS['review-agent'].prompt, /不得返回 changes_requested/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /Triage/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /Verify/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /context/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /repro/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /禁止返回 targetAgent/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /currentFeedbackBatch/);
  assert.match(AGENT_PROFILE_DEFINITIONS['feedback-agent'].prompt, /只执行一次最早回退/);
});
