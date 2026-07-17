import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, FLOW_AGENT_IDS } from './agent-profile';

test('ships rigorous versioned seed prompts for every flow Agent', () => {
  assert.equal(AGENT_PROMPT_SEED_REVISION, 2);
  for (const agentId of FLOW_AGENT_IDS) {
    const prompt = AGENT_PROFILE_DEFINITIONS[agentId].prompt;
    assert.ok(prompt.length >= 450, `${agentId} seed prompt is too small to define a reliable role contract`);
    assert.match(prompt, /# 角色目标/, agentId);
    assert.match(prompt, /# (?:完成条件|判定规则)/, agentId);
    assert.match(prompt, /# (?:决策边界|禁止事项)/, agentId);
  }
});
