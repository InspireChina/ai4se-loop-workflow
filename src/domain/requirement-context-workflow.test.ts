import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIREMENT_CONTEXT_COMMAND_CHAIN,
  REQUIREMENT_CONTEXT_PHASE_ORDER,
  REQUIREMENT_CONTEXT_PHASE_SEQUENCE,
  REQUIREMENT_CONTEXT_WORKFLOW,
  requirementContextNormalCommandPath,
} from './requirement-context-workflow';

test('loads the requirement context workflow entirely from YAML', () => {
  assert.equal(REQUIREMENT_CONTEXT_COMMAND_CHAIN.agent, 'backlog-agent');
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
  assert.match(REQUIREMENT_CONTEXT_PHASE_SEQUENCE, /AS IS.*DECISION TREE.*ACCEPTANCE.*FINALIZE/);
  assert.equal(REQUIREMENT_CONTEXT_WORKFLOW.as_is.type, 'artifact');
  assert.equal(REQUIREMENT_CONTEXT_WORKFLOW.decision_proposal.builtin, 'decision-proposal');
  assert.equal(REQUIREMENT_CONTEXT_WORKFLOW.decision_resolution.builtin, 'decision-resolution');
  assert.equal(REQUIREMENT_CONTEXT_WORKFLOW.answer_review.builtin, 'decision-answer-review');
  assert.equal(REQUIREMENT_CONTEXT_WORKFLOW.finalize.builtin, 'requirement-context-finalize');
  assert.deepEqual(requirementContextNormalCommandPath(), [
    'status',
    ...REQUIREMENT_CONTEXT_PHASE_ORDER.map(() => 'phase complete'),
  ]);
});

test('declares requirement context outputs as generic artifact blocks', () => {
  assert.deepEqual(
    Object.keys(REQUIREMENT_CONTEXT_COMMAND_CHAIN.artifacts['requirement-context'].blocks),
    [
      'intent',
      'assertions',
      'answer-review',
      'change-summary',
      'impacts',
      'scope',
      'constraints',
      'acceptance',
    ],
  );
  assert.equal(REQUIREMENT_CONTEXT_COMMAND_CHAIN.decisionTrees.decisions.builtin, 'decisions');
  assert.match(REQUIREMENT_CONTEXT_WORKFLOW.acceptance.instructions, /需求级验收语义/);
});
