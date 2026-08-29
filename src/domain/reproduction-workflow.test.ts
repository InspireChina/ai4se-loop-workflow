import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPRODUCTION_COMMAND_CHAIN,
  REPRODUCTION_PHASE_ORDER,
  REPRODUCTION_PHASE_SEQUENCE,
  REPRODUCTION_WORKFLOW,
  reproductionNormalCommandPath,
} from './reproduction-workflow';

test('defines Reproduction entirely from the YAML command chain', () => {
  assert.equal(REPRODUCTION_COMMAND_CHAIN.agent, 'repro-agent');
  assert.deepEqual(REPRODUCTION_PHASE_ORDER, [
    'investigation', 'alignment_proposal', 'alignment_resolution', 'answer_review', 'finalize',
  ]);
  assert.equal(
    REPRODUCTION_PHASE_SEQUENCE,
    'INVESTIGATION → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → ANSWER REVIEW → FINALIZE',
  );
  assert.deepEqual(REPRODUCTION_WORKFLOW.investigation.artifactBlocks, [
    { artifactId: 'reproduction', blockId: 'verdict' },
    { artifactId: 'reproduction', blockId: 'steps' },
    { artifactId: 'reproduction', blockId: 'evidence' },
    { artifactId: 'reproduction', blockId: 'hypotheses' },
  ]);
  assert.equal(REPRODUCTION_COMMAND_CHAIN.artifacts.reproduction.blocks.hypotheses.required, false);
  assert.equal(REPRODUCTION_WORKFLOW.alignment_proposal.builtin, 'decision-proposal');
  assert.equal(REPRODUCTION_WORKFLOW.alignment_resolution.builtin, 'decision-resolution');
  assert.equal(REPRODUCTION_WORKFLOW.answer_review.builtin, 'decision-answer-review');
  assert.equal(REPRODUCTION_WORKFLOW.finalize.builtin, 'reproduction-finalize');
  assert.deepEqual(reproductionNormalCommandPath(), [
    'status', 'phase complete', 'phase complete', 'phase complete', 'phase complete', 'phase complete',
  ]);
});
