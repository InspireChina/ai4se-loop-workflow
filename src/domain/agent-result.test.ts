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
