import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateExecutionInvocations, type InvocationObservation } from './execution-invocation';

function harness(observations: Array<InvocationObservation | Error>, submissions: Array<{ summary: string } | null>) {
  const prompts: string[] = [];
  const activities: Array<{ phase: string; count: number; reason?: string }> = [];
  let resets = 0;
  const input = {
    originalPrompt: 'original contract', executorLabel: 'test executor',
    invoke: async (prompt: string) => {
      prompts.push(prompt);
      const next = observations.shift();
      assert.ok(next, 'unexpected additional invocation');
      if (next instanceof Error) throw next;
      return next;
    },
    readSubmission: async () => submissions.shift() ?? null,
    resetStatus: async () => { resets += 1; return true; },
    cancellationReason: async () => 'user stopped',
    recordActivity: async (phase: string, count: number, reason?: string) => { activities.push({ phase, count, reason }); },
    onScheduled: async () => undefined,
    onSucceeded: async () => undefined,
  };
  return { input, prompts, activities, resets: () => resets };
}

function observation(input: Partial<InvocationObservation> = {}): InvocationObservation {
  return { exitCode: 0, diagnostics: [], finalText: '', ...input };
}

test('coordinates serial continuation and retains all diagnostic evidence without a Runner', async () => {
  const h = harness([
    observation({ diagnostics: ['first'], stderrTail: 'tail', failureDetail: 'detail', finalText: 'unfinished' }),
    observation({ diagnostics: ['second'], finalText: 'submitted' }),
  ], [null, { summary: 'done' }]);
  const result = await coordinateExecutionInvocations(h.input);
  assert.equal(result.continuationCount, 1);
  assert.deepEqual(result.execution.diagnostics, ['first', 'second']);
  assert.equal(result.execution.stderrTail, 'tail');
  assert.equal(result.execution.failureDetail, 'detail');
  assert.equal(result.commandSubmission?.summary, 'done');
  assert.equal(h.resets(), 1);
  assert.match(h.prompts[1], /Original Delegation Contract\noriginal contract/);
  assert.match(h.prompts[1], /unfinished/);
  assert.deepEqual(h.activities.map((a) => a.phase), ['scheduled', 'succeeded']);
});

test('persisted submission stops invocation even when the CLI exits with an error', async () => {
  const h = harness([observation({ exitCode: 1 })], [{ summary: 'durable submission' }]);
  const result = await coordinateExecutionInvocations(h.input);
  assert.equal(result.commandSubmission?.summary, 'durable submission');
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.activities, []);
});

test('cancellation during a continuation stops without another invocation', async () => {
  const h = harness([observation(), observation({ cancelled: true })], [null, null]);
  const result = await coordinateExecutionInvocations(h.input);
  assert.equal(result.execution.cancelled, true);
  assert.deepEqual(h.activities.map((a) => a.phase), ['scheduled', 'stopped']);
  assert.equal(h.activities[1].reason, 'user stopped');
  assert.equal(h.prompts.length, 2);
});

test('evidence persistence failure is never mistaken for clean exit continuation', async () => {
  const h = harness([observation({ evidencePersistenceError: 'disk full' })], [null]);
  const result = await coordinateExecutionInvocations(h.input);
  assert.equal(result.continuationCount, 0);
  assert.equal(h.resets(), 0);
});

test('continuation launch and preparation failures preserve their activity record', async () => {
  const launch = harness([observation(), new Error('launch failed')], [null]);
  await assert.rejects(coordinateExecutionInvocations(launch.input), /launch failed/);
  assert.equal(launch.activities[1].reason, 'launch failed');
  const preparation = harness([observation()], [null]);
  preparation.input.resetStatus = async () => { throw new Error('status failed'); };
  await assert.rejects(coordinateExecutionInvocations(preparation.input), /status failed/);
  assert.equal(preparation.activities[1].reason, '准备续跑失败：status failed');
});
