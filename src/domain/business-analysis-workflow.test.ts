import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUSINESS_ANALYSIS_AGENT_IDS,
  BUSINESS_ANALYSIS_WORKFLOWS,
  businessAnalysisPhaseSequence,
} from './business-analysis-workflow';

test('defines one aggregated command chain for every Business Analysis role', () => {
  assert.deepEqual(BUSINESS_ANALYSIS_AGENT_IDS, [
    'idea-context-agent',
    'business-design-agent',
    'requirement-spec-agent',
    'spec-review-agent',
  ]);
  assert.equal(
    businessAnalysisPhaseSequence('idea-context-agent'),
    'DISCOVERY → CLARIFICATION PROPOSAL → CLARIFICATION RESOLUTION → SYNTHESIS → FINALIZE',
  );
  assert.equal(
    businessAnalysisPhaseSequence('business-design-agent'),
    'EXPLORATION → DECISION PROPOSAL → DECISION RESOLUTION → SOLUTION → FINALIZE',
  );
  for (const agent of BUSINESS_ANALYSIS_AGENT_IDS) {
    const workflow = BUSINESS_ANALYSIS_WORKFLOWS[agent];
    assert.ok(workflow.phases.length >= 3);
    for (const phase of workflow.phases) {
      const definition = workflow.definitions[phase];
      assert.ok(definition.objective.length > 10);
      assert.ok(definition.required.length > 0);
      assert.ok(definition.prohibited.length > 0);
    }
  }
});
