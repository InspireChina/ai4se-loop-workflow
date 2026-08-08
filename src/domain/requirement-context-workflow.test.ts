import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIREMENT_CONTEXT_PHASE_ORDER,
  REQUIREMENT_CONTEXT_PHASE_SEQUENCE,
  REQUIREMENT_CONTEXT_WORKFLOW,
  requirementContextNormalCommandPath,
} from './requirement-context-workflow';

test('defines the Backlog phase order, work packets, and normal command path in one catalog', () => {
  assert.deepEqual(REQUIREMENT_CONTEXT_PHASE_ORDER, [
    'as_is',
    'decision_proposal',
    'decision_resolution',
    'to_be',
    'impact_scan',
    'scope',
    'acceptance',
    'finalize',
  ]);
  assert.equal(
    REQUIREMENT_CONTEXT_PHASE_SEQUENCE,
    'AS-IS → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → TO-BE → Impact Scan → SCOPE → Acceptance → Finalize',
  );

  for (const phase of REQUIREMENT_CONTEXT_PHASE_ORDER) {
    const definition = REQUIREMENT_CONTEXT_WORKFLOW[phase];
    assert.ok(definition.objective);
    assert.ok(definition.required);
    assert.ok(definition.prohibited);
    assert.ok(definition.commands.length);
    assert.match(definition.submit, /^requirement-context /);
  }

  assert.deepEqual(requirementContextNormalCommandPath(), [
    'requirement-context as-is complete',
    'requirement-context decision-proposal complete',
    'requirement-context decision-resolution complete',
    'requirement-context to-be complete',
    'requirement-context impact-scan complete',
    'requirement-context scope complete',
    'requirement-context acceptance complete',
    'requirement-context validate',
    'requirement-context complete',
  ]);
  assert.equal(
    REQUIREMENT_CONTEXT_WORKFLOW.decision_resolution.pendingHumanSubmit,
    'requirement-context request-clarification',
  );
});
