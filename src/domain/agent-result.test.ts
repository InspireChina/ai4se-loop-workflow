import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentResult } from './agent-result';

test('parses a structured agent result with role-specific fields', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '拆分完成',
    deliveryUnits: [{ title: '用户可以提交描述' }, { title: '用户可以查看已保存描述' }],
  }));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.deliveryUnits?.length, 2);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.runtimeInputs, []);
});

test('parses generic runtime information requests independently from product questions', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'The repository hook requires delivery metadata.',
    runtimeInputs: [{
      title: '补充交付单元卡号',
      question: '本次提交应关联哪个交付单元卡号？',
      why: '仓库 commit-msg hook 要求该字段。',
      recommendation: '没有关联卡号时请确认使用仓库约定的占位值。',
    }],
  }));
  assert.equal(result.questions.length, 0);
  assert.equal(result.runtimeInputs[0]?.title, '补充交付单元卡号');
});

test('accepts legacy story fields while exposing delivery-unit terminology', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'legacy queued result',
    stories: [{ title: 'Legacy unit' }],
    rewindStory: 1,
  }));
  assert.equal(result.deliveryUnits?.[0]?.title, 'Legacy unit');
  assert.equal(result.rewindDeliveryUnit, 1);
});

test('accepts structured JSON wrapped by common Agent formatting mistakes', () => {
  assert.equal(parseAgentResult('```json\n{"outcome":"completed","summary":"ok"}\n```').summary, 'ok');
  assert.equal(parseAgentResult('结果如下：{"outcome":"completed","summary":"ok"}').summary, 'ok');
  assert.equal(parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'artifact contains a fenced block',
    artifact: { title: 'Delegation', content: '```md\n## Delegation notes\n```' },
  })).artifact?.title, 'Delegation');
  assert.equal(parseAgentResult([
    '```md',
    '## Delegation notes',
    '这不是 JSON。',
    '```',
    '```json',
    '{"outcome":"completed","summary":"recovered"}',
    '```',
  ].join('\n')).summary, 'recovered');
  assert.throws(() => parseAgentResult('只有说明文字，没有结构化结果'));
});

test('rejects invalid workflow values', () => {
  assert.throws(() => parseAgentResult('{"outcome":"done","summary":"ok"}'));
});

test('accepts a batch of more than ten design questions', () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    title: `Decision ${index + 1}`,
    question: `Choose option for decision ${index + 1}`,
    recommendation: 'Use the default option.',
  }));
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Analysis requires design decisions.',
    questions,
  }));
  assert.equal(result.questions.length, 12);
});

test('parses a versionable Slice Spec and normalizes the legacy review verdict', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Decision tree is resolved.',
    verdict: 'ready_for_approval',
    spec: {
      goal: 'A user can close one delivery unit without ambiguity.',
      scope: { included: ['Closure behavior'], excluded: ['Unrelated redesign'] },
      behaviors: [{ scenario: 'All decisions are resolved', expected: 'Development can start' }],
      decisions: [{ key: 'closure-mode', decision: 'Acknowledge reading', rationale: 'No approval gate', source: 'user' }],
      ambiguities: [],
      acceptanceCriteria: [{ id: 'AC-1', description: 'The unit has a deterministic contract', oracle: 'The stored spec is resolved' }],
      verificationPlan: [{ criterionId: 'AC-1', kind: 'command', instruction: 'Run tests', command: 'npm test' }],
      dependencies: [],
      changeBudget: { capabilities: ['Task closure'], paths: ['src/application/tasks.ts'] },
    },
  }));
  assert.equal(result.verdict, 'report_ready');
  assert.equal(result.spec?.acceptanceCriteria[0]?.id, 'AC-1');
});

test('parses Feedback Agent triage and verification decisions', () => {
  const triage = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Route the feedback back to implementation.',
    feedback: {
      mode: 'triage',
      commentId: 'feedback-1',
      disposition: 'rewind',
      targetStage: 'dev',
      targetAgent: 'dev-agent',
      targetDeliveryUnit: 1,
      reason: 'The comment identifies an implementation defect.',
      acceptance: ['The behavior is restored and tested.'],
    },
  }));
  assert.equal(triage.feedback?.mode, 'triage');
  const verification = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Feedback resolution verified.',
    feedback: {
      mode: 'verify',
      commentId: 'feedback-1',
      verdict: 'resolved',
      reason: 'The new behavior and evidence satisfy the feedback.',
      evidence: ['verification-run-1'],
    },
  }));
  assert.equal(verification.feedback?.mode, 'verify');
});
