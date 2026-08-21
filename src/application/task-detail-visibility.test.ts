import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSINESS_ANALYSIS_AGENT_IDS } from '../domain/business-analysis-workflow';
import { taskDetailVisibility } from './task-detail-visibility';

test('shows decision alignment throughout the standalone Business Analysis pipeline', () => {
  assert.deepEqual(taskDetailVisibility({
    itemType: 'business-analysis',
    currentSubagent: 'idea-context-agent',
  }), {
    isBusinessAnalysis: true,
    isEndToEnd: false,
    isDirect: false,
    inBusinessAnalysisStage: true,
    showDeliveryWorkflow: false,
    showDecisionAlignment: true,
  });
});

test('shows decision alignment while End to End is still in every Business Analysis stage', () => {
  for (const currentSubagent of BUSINESS_ANALYSIS_AGENT_IDS) {
    const visibility = taskDetailVisibility({ itemType: 'end-to-end', currentSubagent });
    assert.equal(visibility.inBusinessAnalysisStage, true);
    assert.equal(visibility.showDeliveryWorkflow, false);
    assert.equal(visibility.showDecisionAlignment, true);
  }
});

test('keeps delivery visibility independent and hides decision alignment only for Direct', () => {
  for (const itemType of ['end-to-end', 'feature', 'bug']) {
    const visibility = taskDetailVisibility({ itemType, currentSubagent: 'backlog-agent' });
    assert.equal(visibility.showDeliveryWorkflow, true);
    assert.equal(visibility.showDecisionAlignment, true);
  }

  const direct = taskDetailVisibility({ itemType: 'direct', currentSubagent: 'direct-agent' });
  assert.equal(direct.showDeliveryWorkflow, false);
  assert.equal(direct.showDecisionAlignment, false);
});
