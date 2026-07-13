import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentResult } from './agent-result';

test('parses a structured agent result with role-specific fields', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '拆分完成',
    stories: [{ title: '创建表单' }, { title: '保存描述' }],
  }));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.stories?.length, 2);
  assert.deepEqual(result.questions, []);
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
