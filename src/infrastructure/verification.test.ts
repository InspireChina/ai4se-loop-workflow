import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVerificationCommandAllowed, executeVerificationCommand } from './verification';

test('Harness accepts any non-empty Slice Spec verification command', () => {
  assert.equal(assertVerificationCommandAllowed('npm test'), 'npm test');
  assert.equal(assertVerificationCommandAllowed('python -m pytest tests/unit'), 'python -m pytest tests/unit');
  assert.equal(assertVerificationCommandAllowed('git diff --name-only HEAD~1..HEAD && rg -n "REQ-1|Unit.?1" docs/trace.md'), 'git diff --name-only HEAD~1..HEAD && rg -n "REQ-1|Unit.?1" docs/trace.md');
  assert.throws(() => assertVerificationCommandAllowed('  '), /不能为空/);
});

test('Harness captures deterministic command evidence', async () => {
  const result = await executeVerificationCommand('node --version', process.cwd(), 10_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /^v\d+/);
});

test('Harness executes full shell verification commands', async () => {
  const result = await executeVerificationCommand('git diff --name-only HEAD~1..HEAD && rg -n "name" package.json', process.cwd(), 10_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /name/);
});
