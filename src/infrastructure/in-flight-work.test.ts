import assert from 'node:assert/strict';
import test from 'node:test';
import { InFlightWork, executionInFlightKey } from './in-flight-work';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('launches distinct reserved Work Items sharing a requirement and control lane without losing a planned execution', async () => {
  const work = new InFlightWork<{ executionId: string; work: { taskId: string; lane: string; workItemId: string } }>();
  const review = { executionId: 'SOURCE-review', work: { taskId: 'REQ-shared', lane: 'control', workItemId: 'ITEM-review' } };
  const verify = { executionId: 'SOURCE-feedback-verify', work: { taskId: 'REQ-shared', lane: 'control', workItemId: 'ITEM-feedback-verify' } };
  const gates = [deferred(), deferred()];
  const starts: string[] = [];
  for (const [index, source] of [review, verify].entries()) {
    assert.equal(work.launch(executionInFlightKey(source), source, async () => { starts.push(source.executionId); await gates[index].promise; }, () => {}), true);
  }
  assert.equal(work.launch(executionInFlightKey(review), review, async () => { throw new Error('duplicate must not start'); }, () => {}), false);
  await Promise.resolve();
  assert.deepEqual(starts, ['SOURCE-review', 'SOURCE-feedback-verify']);
  assert.equal(work.size, 2);
  for (const gate of gates) gate.resolve();
  while (work.size) await work.waitForNextCompletion();
});

test('a replacement execution for the same Work Item is not hidden by an ending cancelled source', async () => {
  const work = new InFlightWork<{ executionId: string; workItemId: string }>();
  const old = { executionId: 'SOURCE-cancelled-still-ending', workItemId: 'ITEM-resumed' };
  const replacement = { executionId: 'SOURCE-resumed', workItemId: 'ITEM-resumed' };
  const ending = deferred();
  assert.equal(work.launch(executionInFlightKey(old), old, () => ending.promise, () => {}), true);
  assert.equal(work.launch(executionInFlightKey(replacement), replacement, async () => {}, () => {}), true);
  assert.throws(() => executionInFlightKey({ executionId: '' }), /真实 execution_id/);
  await work.waitForNextCompletion();
  assert.deepEqual(work.values(), [old]);
  ending.resolve();
  await work.waitForNextCompletion();
});

test('wakes on the first completion and permits immediate replacement while other work continues', async () => {
  const work = new InFlightWork<string>();
  const analysis = deferred();
  const browser = deferred();
  const replacement = deferred();
  const events: string[] = [];

  assert.equal(work.launch('analysis', 'analysis', async () => {
    events.push('analysis:start');
    await analysis.promise;
    events.push('analysis:end');
  }, () => {}), true);
  assert.equal(work.launch('browser', 'browser', async () => {
    events.push('browser:start');
    await browser.promise;
    events.push('browser:end');
  }, () => {}), true);

  await Promise.resolve();
  browser.resolve();
  await work.waitForNextCompletion();
  assert.deepEqual(work.values(), ['analysis']);

  assert.equal(work.launch('replacement', 'replacement', async () => {
    events.push('replacement:start');
    await replacement.promise;
    events.push('replacement:end');
  }, () => {}), true);
  await Promise.resolve();
  assert.equal(events.includes('replacement:start'), true);
  assert.equal(events.includes('analysis:end'), false);

  replacement.resolve();
  analysis.resolve();
  while (work.size) await work.waitForNextCompletion();
});

test('deduplicates active keys and isolates failures from remaining work', async () => {
  const work = new InFlightWork<string>();
  const survivor = deferred();
  const errors: string[] = [];

  assert.equal(work.launch('same-lane', 'failing', async () => {
    throw new Error('boom');
  }, (error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  }), true);
  assert.equal(work.launch('same-lane', 'duplicate', async () => {}, () => {}), false);
  assert.equal(work.launch('other-lane', 'survivor', async () => {
    await survivor.promise;
  }, () => {}), true);

  await work.waitForNextCompletion();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(work.values(), ['survivor']);
  survivor.resolve();
  await work.waitForNextCompletion();
  assert.equal(work.size, 0);
});

test('does not miss a completion that occurs while the scheduler calculates candidates', async () => {
  const work = new InFlightWork<string>();
  const execution = deferred();

  work.launch('analysis', 'analysis', () => execution.promise, () => undefined);
  const revisionBeforeScheduling = work.revision();
  execution.resolve();
  while (work.size) await Promise.resolve();

  await work.waitForNextCompletion(revisionBeforeScheduling);
  assert.equal(work.revision(), revisionBeforeScheduling + 1);
});
