import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VERIFICATION_PHASE_ORDER,
  VERIFICATION_PHASE_SEQUENCE,
  VERIFICATION_WORKFLOW,
  verificationNormalCommandPath,
} from './verification-workflow';

test('verification workflow exposes the four hard-gated work packets', () => {
  assert.deepEqual(VERIFICATION_PHASE_ORDER, ['plan', 'execute', 'evidence_review', 'finalize']);
  assert.equal(VERIFICATION_PHASE_SEQUENCE, 'PLAN → EXECUTE → EVIDENCE REVIEW → FINALIZE');
  assert.deepEqual(verificationNormalCommandPath(), [
    'verification plan complete',
    'verification execute complete',
    'verification evidence-review complete',
    'verification validate',
    'verification complete',
  ]);
  assert.match(VERIFICATION_WORKFLOW.evidence_review.prohibited, /不要在本阶段修改场景或执行结果/);
  assert.match(VERIFICATION_WORKFLOW.finalize.reviewBeforeSubmit.join('\n'), /不泄露内部稳定 key/);
});
