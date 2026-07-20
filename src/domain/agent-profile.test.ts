import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, FLOW_AGENT_IDS } from './agent-profile';

test('ships rigorous versioned seed prompts for every flow Agent', () => {
  assert.equal(AGENT_PROMPT_SEED_REVISION, 6);
  for (const agentId of FLOW_AGENT_IDS) {
    const prompt = AGENT_PROFILE_DEFINITIONS[agentId].prompt;
    assert.ok(prompt.length >= 450, `${agentId} seed prompt is too small to define a reliable role contract`);
    assert.match(prompt, /# 角色目标/, agentId);
    assert.match(prompt, /# (?:完成条件|判定规则)/, agentId);
    assert.match(prompt, /# (?:决策边界|禁止事项)/, agentId);
  }
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /现有实现已经满足规格/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /不要为了制造 diff/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /提交不是完成前提/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /只能暂存本轮相关改动/);
  assert.match(AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt, /runtimeInputs/);
  assert.match(AGENT_PROFILE_DEFINITIONS['test-agent'].prompt, /runtimeInputs/);
  assert.match(AGENT_PROFILE_DEFINITIONS['review-agent'].prompt, /逐条说明如何处理/);
  assert.match(AGENT_PROFILE_DEFINITIONS['review-agent'].prompt, /verdict=changes_requested/);
});
