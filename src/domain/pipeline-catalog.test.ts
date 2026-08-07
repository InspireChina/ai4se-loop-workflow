import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIREMENT_PIPELINES, requirementPipeline } from './pipeline-catalog';

test('exposes exactly the read-only feature and BUG pipelines', () => {
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.id), ['feature', 'bug']);
  assert.deepEqual(REQUIREMENT_PIPELINES.map((pipeline) => pipeline.label), ['功能需求', 'BUG']);
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
  assert.equal(requirementPipeline('feature'), 'feature');
  assert.equal(requirementPipeline('bug'), 'bug');
  assert.throws(() => requirementPipeline('tech'), /只能选择功能需求或 BUG/);
  assert.throws(() => requirementPipeline(null), /只能选择功能需求或 BUG/);
});
