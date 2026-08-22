import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCleanExitContinuationPrompt,
  shouldContinueAfterCleanExit,
} from './terminal-command-recovery';

test('continues every clean CLI exit without a terminal submission, even without final text', () => {
  assert.equal(shouldContinueAfterCleanExit({
    exitCode: 0,
    hasSubmission: false,
    cancelled: false,
  }), true);
  assert.equal(shouldContinueAfterCleanExit({ exitCode: 1, hasSubmission: false, cancelled: false }), false);
  assert.equal(shouldContinueAfterCleanExit({ exitCode: 0, hasSubmission: true, cancelled: false }), false);
  assert.equal(shouldContinueAfterCleanExit({ exitCode: 0, hasSubmission: false, cancelled: true }), false);
  assert.equal(shouldContinueAfterCleanExit({
    exitCode: 0,
    hasSubmission: false,
    cancelled: false,
    evidencePersistenceError: 'disk full',
  }), false);
});

test('continuation prompt resumes any command-chain stage and redacts sensitive text', () => {
  const prompt = buildCleanExitContinuationPrompt({
    originalPrompt: 'Run loop-agent status, perform implementation and tests, then loop-agent complete.',
    previousFinalText: 'Implemented the change. token=super-secret',
    continuationNumber: 2,
  });
  assert.match(prompt, /可能停在命令链的任意阶段/);
  assert.match(prompt, /允许完成尚未完成的分析、实现、命令、长时间测试/);
  assert.match(prompt, /必须先执行 status/);
  assert.match(prompt, /loop-agent complete/);
  assert.match(prompt, /Implemented the change/);
  assert.doesNotMatch(prompt, /super-secret/);
});
