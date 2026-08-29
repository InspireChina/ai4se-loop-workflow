import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEEDBACK_TRIAGE_COMMAND_CHAIN,
  FEEDBACK_TRIAGE_PHASE_ORDER,
  FEEDBACK_VERIFY_COMMAND_CHAIN,
  FEEDBACK_VERIFY_PHASE_ORDER,
} from './feedback-workflow';

test('Feedback triage and verification are separate YAML command chains', () => {
  assert.equal(FEEDBACK_TRIAGE_COMMAND_CHAIN.agent, 'feedback-agent');
  assert.deepEqual(FEEDBACK_TRIAGE_PHASE_ORDER, [
    'inputs', 'clarification_proposal', 'clarification_resolution',
    'answer_review', 'grouping', 'finalize',
  ]);
  assert.equal(FEEDBACK_TRIAGE_COMMAND_CHAIN.phases.finalize.builtin, 'feedback-triage-finalize');
  assert.equal(FEEDBACK_VERIFY_COMMAND_CHAIN.agent, 'feedback-agent');
  assert.deepEqual(FEEDBACK_VERIFY_PHASE_ORDER, ['inputs', 'verify', 'finalize']);
  assert.equal(FEEDBACK_VERIFY_COMMAND_CHAIN.phases.finalize.builtin, 'feedback-verify-finalize');
});
