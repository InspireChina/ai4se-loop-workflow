import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { decisionAlignmentQuestions, decisionAnswerText } from './decision-alignment';
import type { DeliverySpecRecord, Question } from './tasks';

function specRecord(overrides: Partial<DeliverySpecRecord> = {}): DeliverySpecRecord {
  return {
    spec_id: 'SPEC-1',
    task_id: 'TASK-1',
    story_index: 1,
    revision: 1,
    status: 'resolved',
    spec_json: JSON.stringify(deliverySpecFixture()),
    source_result_id: null,
    created_at: '2026-08-08 10:00:00',
    resolved_at: '2026-08-08 10:01:00',
    ...overrides,
  };
}

test('projects resolved delivery-analysis decisions into the read-only alignment view', () => {
  const spec = deliverySpecFixture({
    decisions: [{
      key: 'verdict-scale',
      type: 'business',
      title: 'Overall verdict scale',
      question: 'How should the overall verdict be expressed?',
      impact: 'The scale changes the result visible to the user.',
      options: [
        { id: 'binary', label: 'Binary', consequences: ['Only ready or not ready'] },
        { id: 'three-level', label: 'Three levels', consequences: ['Preserves a partial state'] },
      ],
      status: 'resolved',
      selectedOption: 'three-level',
      authority: 'agent_authority',
      decision: 'Use a three-level verdict.',
      rationale: 'A partial state makes the result actionable.',
      evidence: 'The delivery outcome requires both a conclusion and improvement gaps.',
    }],
  });

  const result = decisionAlignmentQuestions([], [specRecord({ spec_json: JSON.stringify(spec) })]);

  assert.equal(result.length, 1);
  assert.equal(result[0].source_agent, 'analyst-agent');
  assert.equal(result[0].decision_authority, 'agent');
  assert.equal(result[0].status, 'resolved');
  assert.equal(result[0].answer, 'Use a three-level verdict.');
  assert.equal(result[0].selected_option_id, 'three-level');
  assert.equal(result[0].spec_revision, 1);
});

test('does not duplicate delivery decisions already published as questions', () => {
  const existing = {
    question_id: 'Q-1',
    task_id: 'TASK-1',
    story_index: 1,
    title: 'Existing decision',
    question: 'Existing question?',
    why: null,
    recommendation: null,
    answer: 'Existing answer',
    status: 'resolved',
    relative_path: null,
    source_agent: 'analyst-agent',
    kind: 'analysis',
    decision_key: 'verdict-scale',
    alternatives_json: null,
    recommendation_reason: null,
    depends_on_json: null,
    activation_json: null,
    selected_option_id: null,
    status_reason: null,
    decision_authority: 'agent',
    spec_revision: 1,
    resolved_at: '2026-08-08 10:01:00',
    created_at: '2026-08-08 10:00:00',
    updated_at: '2026-08-08 10:01:00',
  } satisfies Question;
  const spec = deliverySpecFixture({
    decisions: [{
      key: 'verdict-scale',
      type: 'business',
      title: 'Overall verdict scale',
      question: 'How should the overall verdict be expressed?',
      impact: 'Changes the visible result.',
      options: [],
      status: 'resolved',
      authority: 'upstream',
      decision: 'Use the inherited scale.',
      rationale: 'Already decided upstream.',
      evidence: 'Requirement context.',
    }],
  });

  const result = decisionAlignmentQuestions([existing], [specRecord({ spec_json: JSON.stringify(spec) })]);

  assert.deepEqual(result, [existing]);
});

test('uses only the latest active delivery-spec revision for each unit', () => {
  const oldSpec = deliverySpecFixture({
    decisions: [{
      key: 'old-decision',
      type: 'technical',
      title: 'Old decision',
      question: 'Old?',
      impact: 'Old impact.',
      options: [],
      status: 'resolved',
      authority: 'project_evidence',
      decision: 'Old.',
      rationale: 'Old.',
      evidence: 'Old.',
    }],
  });
  const currentSpec = deliverySpecFixture({
    decisions: [{
      key: 'current-decision',
      type: 'technical',
      title: 'Current decision',
      question: 'Current?',
      impact: 'Current impact.',
      options: [],
      status: 'resolved',
      authority: 'project_evidence',
      decision: 'Current.',
      rationale: 'Current.',
      evidence: 'Current.',
    }],
  });

  const result = decisionAlignmentQuestions([], [
    specRecord({ spec_id: 'SPEC-OLD', revision: 1, status: 'superseded', spec_json: JSON.stringify(oldSpec) }),
    specRecord({ spec_id: 'SPEC-CURRENT', revision: 2, spec_json: JSON.stringify(currentSpec) }),
  ]);

  assert.deepEqual(result.map((question) => question.decision_key), ['current-decision']);
});

test('joins a resolved decision and option consequences without duplicate punctuation', () => {
  assert.equal(decisionAnswerText('Use three levels.', ['Preserves a partial state']), 'Use three levels. Preserves a partial state');
  assert.equal(decisionAnswerText('Use three levels', ['Preserves a partial state']), 'Use three levels。Preserves a partial state');
});
