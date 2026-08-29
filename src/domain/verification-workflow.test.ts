import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VERIFICATION_COMMAND_CHAIN,
  VERIFICATION_PHASE_ORDER,
  VERIFICATION_PHASE_SEQUENCE,
  VERIFICATION_WORKFLOW,
  verificationNormalCommandPath,
} from './verification-workflow';

test('defines Verification entirely from the YAML command chain', () => {
  assert.equal(VERIFICATION_COMMAND_CHAIN.agent, 'test-agent');
  assert.deepEqual(VERIFICATION_PHASE_ORDER, ['inputs', 'plan', 'execute', 'evidence_review', 'finalize']);
  assert.equal(
    VERIFICATION_PHASE_SEQUENCE,
    'FROZEN VERIFICATION INPUTS → PLAN → EXECUTE → EVIDENCE REVIEW → FINALIZE',
  );
  assert.equal(VERIFICATION_WORKFLOW.inputs.builtin, 'verification-inputs');
  assert.equal(VERIFICATION_WORKFLOW.plan.builtin, 'verification-plan');
  assert.equal(VERIFICATION_WORKFLOW.execute.builtin, 'verification-execution');
  assert.equal(VERIFICATION_WORKFLOW.evidence_review.type, 'artifact');
  assert.equal(VERIFICATION_WORKFLOW.finalize.builtin, 'verification-finalize');
  assert.equal(VERIFICATION_COMMAND_CHAIN.artifacts.verification.blocks.sources.writable, false);
  assert.deepEqual(verificationNormalCommandPath(), [
    'status', 'phase complete', 'phase complete', 'phase complete', 'phase complete', 'phase complete',
  ]);
});
