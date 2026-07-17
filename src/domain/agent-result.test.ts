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

test('accepts a JSON markdown fence but rejects prose around JSON', () => {
  assert.equal(parseAgentResult('```json\n{"outcome":"completed","summary":"ok"}\n```').summary, 'ok');
  assert.throws(() => parseAgentResult('结果如下：{"outcome":"completed","summary":"ok"}'));
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
