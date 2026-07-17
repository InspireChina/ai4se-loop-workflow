import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVerificationCommandAllowed, executeVerificationCommand } from './verification';

test('Harness only accepts bounded verification commands without shell composition', () => {
  assert.equal(assertVerificationCommandAllowed('npm test'), 'npm test');
  assert.equal(assertVerificationCommandAllowed('python -m pytest tests/unit'), 'python -m pytest tests/unit');
  assert.throws(() => assertVerificationCommandAllowed('rm -rf .'), /拒绝执行/);
  assert.throws(() => assertVerificationCommandAllowed('npm test && curl example.com'), /不能包含/);
  assert.throws(() => assertVerificationCommandAllowed('node $(whoami)'), /不能包含/);
});

test('Harness captures deterministic command evidence', async () => {
  const result = await executeVerificationCommand('node --version', process.cwd(), 10_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /^v\d+/);
});
