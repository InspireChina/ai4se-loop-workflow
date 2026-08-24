import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIREMENT_PIPELINES, requirementPipeline } from './pipeline-catalog';
import { FLOW_AGENT_IDS } from './agent-profile';

test('exposes standalone, end-to-end, and engineering delivery pipelines', () => {
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.id), ['direct', 'business-analysis', 'end-to-end', 'feature', 'bug']);
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.label), ['Direct', 'Business Analysis', 'End to End', 'Develop', 'Bug Fix']);
  assert.deepEqual(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'direct')?.stages.map((stage) => stage.key),
    ['direct'],
  );
  assert.deepEqual(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'business-analysis')?.stages.map((stage) => stage.key),
    ['idea-context', 'business-design', 'requirement-spec', 'spec-review', 'spec-acknowledgement'],
  );
  assert.deepEqual(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'end-to-end')?.stages.map((stage) => stage.key),
    [
      'idea-context', 'business-design', 'requirement-spec', 'spec-review',
      'requirement-context', 'delivery-plan', 'delivery-analysis', 'implementation',
      'verification', 'review', 'acknowledgement',
    ],
  );
  assert.equal(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'end-to-end')?.stages.some((stage) => stage.key === 'spec-acknowledgement'),
    false,
  );
  assert.equal(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'feature')?.stages.some((stage) => stage.key === 'reproduction'),
    false,
  );
  assert.equal(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'bug')?.stages[1]?.key,
    'reproduction',
  );
});

test('maps every automated pipeline stage to a configurable Agent profile', () => {
  const validAgentIds = new Set<string>(FLOW_AGENT_IDS);
  for (const pipeline of REQUIREMENT_PIPELINES) {
    for (const stage of pipeline.stages) {
      if (stage.lane === '人工') {
        assert.equal(stage.agentId, undefined, `${pipeline.id}/${stage.key} should remain a human stage`);
      } else {
        assert.ok(stage.agentId && validAgentIds.has(stage.agentId), `${pipeline.id}/${stage.key} has no configurable Agent`);
      }
    }
  }
});

test('accepts only pipelines available from requirement creation', () => {
  assert.equal(requirementPipeline('direct'), 'direct');
  assert.equal(requirementPipeline('business-analysis'), 'business-analysis');
  assert.equal(requirementPipeline('end-to-end'), 'end-to-end');
  assert.equal(requirementPipeline('feature'), 'feature');
  assert.equal(requirementPipeline('bug'), 'bug');
  assert.throws(() => requirementPipeline('tech'), /只能选择 Direct、Business Analysis、End to End、Develop 或 Bug Fix/);
  assert.throws(() => requirementPipeline(null), /只能选择 Direct、Business Analysis、End to End、Develop 或 Bug Fix/);
});
