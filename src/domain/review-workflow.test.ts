import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_GAP_PATH, REVIEW_HAPPY_PATH, REVIEW_WORKFLOW } from './review-workflow';

test('review workflow branches to report or forward delivery units', () => {
  assert.equal(REVIEW_HAPPY_PATH, 'FACT RECONCILIATION → CLOSURE ASSESSMENT → REPORT → FINALIZE');
  assert.equal(REVIEW_GAP_PATH, 'FACT RECONCILIATION → CLOSURE ASSESSMENT → FORWARD DELIVERY UNITS → FINALIZE');
  assert.match(REVIEW_WORKFLOW.forward_units.required, /每个活动缺口恰好被一个完整单元覆盖/);
  assert.match(REVIEW_WORKFLOW.forward_units.reviewBeforeSubmit.join('\n'), /绕过 Story Splitter/);
});
