import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIREMENT_PIPELINES, requirementPipeline } from './pipeline-catalog';

test('exposes Business Analysis separately from the engineering delivery pipelines', () => {
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.id), ['business-analysis', 'feature', 'bug']);
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.label), ['Business Analysis', '功能需求', 'BUG']);
  assert.deepEqual(
    REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'business-analysis')?.stages.map((stage) => stage.key),
    ['idea-context', 'business-design', 'requirement-spec', 'spec-review', 'spec-acknowledgement'],
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

test('accepts only pipelines available from requirement creation', () => {
  assert.equal(requirementPipeline('business-analysis'), 'business-analysis');
  assert.equal(requirementPipeline('feature'), 'feature');
  assert.equal(requirementPipeline('bug'), 'bug');
  assert.throws(() => requirementPipeline('tech'), /只能选择 Business Analysis、功能需求或 BUG/);
  assert.throws(() => requirementPipeline(null), /只能选择 Business Analysis、功能需求或 BUG/);
});
