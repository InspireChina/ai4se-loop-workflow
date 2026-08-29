import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_PHASE_ORDER, REVIEW_WORKFLOW } from './review-workflow';

test('Review workflow is loaded from the generic YAML command chain', () => {
  assert.deepEqual(REVIEW_PHASE_ORDER, [
    'inputs',
    'fact_reconciliation',
    'closure_assessment',
    'closure_output',
    'finalize',
  ]);
  assert.equal(REVIEW_WORKFLOW.fact_reconciliation.builtin, 'review-reconciliation');
  assert.equal(REVIEW_WORKFLOW.closure_output.builtin, 'review-output');
  assert.match(REVIEW_WORKFLOW.finalize.instructions, /report_ready.*closure_gap/);
});
