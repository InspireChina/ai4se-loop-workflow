import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTerminalCommandRecoveryPrompt,
  shouldAttemptTerminalCommandRecovery,
} from './terminal-command-recovery';

test('only recovers a successful CLI exit with final text and no terminal submission', () => {
  assert.equal(shouldAttemptTerminalCommandRecovery({
    exitCode: 0,
    finalText: 'work is complete',
    hasSubmission: false,
    cancelled: false,
  }), true);
  assert.equal(shouldAttemptTerminalCommandRecovery({ exitCode: 1, finalText: 'done', hasSubmission: false, cancelled: false }), false);
  assert.equal(shouldAttemptTerminalCommandRecovery({ exitCode: 0, finalText: '', hasSubmission: false, cancelled: false }), false);
  assert.equal(shouldAttemptTerminalCommandRecovery({ exitCode: 0, finalText: 'done', hasSubmission: true, cancelled: false }), false);
  assert.equal(shouldAttemptTerminalCommandRecovery({ exitCode: 0, finalText: 'done', hasSubmission: false, cancelled: true }), false);
  assert.equal(shouldAttemptTerminalCommandRecovery({
    exitCode: 0,
    finalText: 'done',
    hasSubmission: false,
    cancelled: false,
    evidencePersistenceError: 'disk full',
  }), false);
});

test('recovery prompt is submission-only and redacts sensitive text', () => {
  const prompt = buildTerminalCommandRecoveryPrompt({
    commandPrompt: 'Run loop-agent status, then loop-agent complete.',
    previousFinalText: 'Implemented the change. token=super-secret',
  });
  assert.match(prompt, /禁止重新实现、重新分析、重新运行测试/);
  assert.match(prompt, /必须先执行当前角色的 status 命令/);
  assert.match(prompt, /loop-agent complete/);
  assert.match(prompt, /Implemented the change/);
  assert.doesNotMatch(prompt, /super-secret/);
});
