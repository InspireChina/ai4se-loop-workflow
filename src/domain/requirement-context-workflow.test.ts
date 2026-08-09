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
    'answer_review',
    'to_be',
    'impact_scan',
    'scope',
    'acceptance',
    'finalize',
  ]);
  assert.equal(
    REQUIREMENT_CONTEXT_PHASE_SEQUENCE,
    'AS-IS → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → ANSWER REVIEW → TO-BE → Impact Scan → SCOPE → Acceptance → Finalize',
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
    'requirement-context answer-review complete',
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
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.answer_review.objective, /HUMAN 与 Agent/);
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.answer_review.prohibited, /回到 PROPOSE/);
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.decision_proposal.objective, /输入业务方案.*规格和代码现状冲突.*遗漏影响/);
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.decision_proposal.prohibited, /不要主动改良、替换或扩展输入业务方案/);
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.to_be.objective, /输入业务方案.*AS-IS 与影响核对的 TO-BE/);
});
