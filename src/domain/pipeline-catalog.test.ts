import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIREMENT_PIPELINES, requirementPipeline } from './pipeline-catalog';

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

test('accepts only pipelines available from requirement creation', () => {
  assert.equal(requirementPipeline('direct'), 'direct');
  assert.equal(requirementPipeline('business-analysis'), 'business-analysis');
  assert.equal(requirementPipeline('end-to-end'), 'end-to-end');
  assert.equal(requirementPipeline('feature'), 'feature');
  assert.equal(requirementPipeline('bug'), 'bug');
  assert.throws(() => requirementPipeline('tech'), /只能选择 Direct、Business Analysis、End to End、Develop 或 Bug Fix/);
  assert.throws(() => requirementPipeline(null), /只能选择 Direct、Business Analysis、End to End、Develop 或 Bug Fix/);
});
