import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERY_ANALYSIS_PHASE_ORDER,
  DELIVERY_ANALYSIS_PHASE_SEQUENCE,
  DELIVERY_ANALYSIS_WORKFLOW,
  deliveryAnalysisNormalCommandPath,
} from './delivery-analysis-workflow';

test('defines the Delivery Analysis phase order and work packets in one catalog', () => {
  assert.deepEqual(DELIVERY_ANALYSIS_PHASE_ORDER, [
    'impact_scan', 'decision_proposal', 'decision_resolution', 'answer_review', 'delivery_contract', 'finalize',
  ]);
  assert.equal(
    DELIVERY_ANALYSIS_PHASE_SEQUENCE,
    'AS-IS & IMPACT SCAN → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → ANSWER REVIEW → DELIVERY CONTRACT → FINALIZE',
  );
  for (const phase of DELIVERY_ANALYSIS_PHASE_ORDER) {
    const packet = DELIVERY_ANALYSIS_WORKFLOW[phase];
    assert.ok(packet.title);
    assert.ok(packet.objective);
    assert.ok(packet.required);
    assert.ok(packet.prohibited);
    assert.ok(packet.commands.length);
    assert.ok(packet.reviewBeforeSubmit.length);
    assert.match(packet.submit, /^delivery-analysis /);
  }
  assert.deepEqual(deliveryAnalysisNormalCommandPath(), [
    'delivery-analysis impact-scan complete',
    'delivery-analysis decision-proposal complete',
    'delivery-analysis decision-resolution complete',
    'delivery-analysis answer-review complete',
    'delivery-analysis contract complete',
    'delivery-analysis validate',
    'delivery-analysis complete',
  ]);
  assert.match(DELIVERY_ANALYSIS_WORKFLOW.answer_review.objective, /HUMAN、上游、项目证据与 Agent/);
  assert.match(DELIVERY_ANALYSIS_WORKFLOW.answer_review.prohibited, /回到 PROPOSE/);
});
