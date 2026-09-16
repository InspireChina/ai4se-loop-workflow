import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepairActivityMonitor, repairOperation, type RepairActivityEvent } from './repair-activity';

const tool = (id: string, input: unknown, phase: 'started' | 'completed', extra: Partial<RepairActivityEvent> = {}): RepairActivityEvent =>
  ({ name: 'loop.agent.tool', tool: 'Read', toolClass: 'other', toolCallId: id, input, phase, success: phase === 'completed' ? true : undefined, ...extra });
function fixture() {
  let now = 0;
  const completed = new Set<string>();
  const monitor = createRepairActivityMonitor({ now: () => now, timeoutMs: 100, longToolTimeoutMs: 100,
    known: operation => completed.has(operation), checkpoint: operation => {
      if (completed.has(operation)) return false;
      completed.add(operation); return true;
    } });
  monitor.begin();
  return { monitor, completed, advance: (value: number) => { now = value; } };
}

test('plain output, failed tools, unknown results and self-reported findings never renew investigation', () => {
  const h = fixture();
  h.advance(90);
  h.monitor.observe({ name: 'loop.agent.output', input: 'I made progress', success: true });
  h.monitor.observe(tool('failed', { file: 'x' }, 'completed', { success: false }));
  h.monitor.observe({ name: 'loop.agent.tool', phase: 'completed', tool: 'tool', success: true });
  h.monitor.observe(tool('status', { command: 'node /installed/loop-admin.cjs status' }, 'completed', { tool: 'Bash', toolClass: 'shell', exitCode: 0 }));
  h.monitor.observe(tool('evidence', { command: 'node /app/loop-admin-entry.ts evidence record --payload "a new claim"' }, 'completed', { tool: 'Bash', toolClass: 'shell', exitCode: 0 }));
  h.advance(100);
  assert.match(h.monitor.failure()!, /stalled/);
  assert.equal(h.completed.size, 0);
});

test('completed novel operation renews once; reordered arguments and new IDs do not turn repeated work into progress', () => {
  const h = fixture();
  h.advance(80);
  h.monitor.observe(tool('first', { path: 'feature.ts', offset: 1 }, 'started'));
  h.monitor.observe(tool('first', undefined, 'completed', { tool: 'tool' }));
  h.advance(170);
  h.monitor.observe(tool('repeat', { offset: 1, path: 'feature.ts' }, 'completed'));
  assert.equal(h.monitor.failure(), null);
  h.advance(180);
  assert.match(h.monitor.failure()!, /stalled/);
  assert.equal(h.completed.size, 1);
});

test('long shell lease is bounded and cannot be renewed by duplicate or failing started calls', () => {
  const h = fixture();
  h.advance(80);
  h.monitor.observe(tool('java', { command: 'mvn test' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  h.advance(110);
  assert.equal(h.monitor.failure(), null);
  h.monitor.observe(tool('other', { command: 'mvn verify' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  h.advance(150);
  h.monitor.observe(tool('java', undefined, 'completed', { tool: 'tool', success: false, exitCode: 1 }));
  h.monitor.observe(tool('third', { command: 'mvn e2e' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  h.advance(180);
  assert.match(h.monitor.failure()!, /stalled/);
});

test('explicit failing shell exit cannot create a checkpoint even if a runtime reports success', () => {
  const h = fixture();
  h.monitor.observe(tool('shell', { command: 'failing-check' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  h.advance(90);
  h.monitor.observe(tool('shell', undefined, 'completed', { tool: 'tool', success: true, exitCode: 1 }));
  h.advance(100);
  assert.match(h.monitor.failure()!, /stalled/);
  assert.equal(h.completed.size, 0);
});

test('reported successful long shell completion allows finishing without pretending to verify acceptance', () => {
  const h = fixture();
  h.advance(80);
  h.monitor.observe(tool('shell', { command: 'java e2e' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  h.advance(170);
  assert.equal(h.monitor.failure(), null);
  h.monitor.observe(tool('shell', undefined, 'completed', { tool: 'tool', success: true, exitCode: null }));
  h.advance(260);
  assert.equal(h.monitor.failure(), null);
  h.advance(270);
  assert.match(h.monitor.failure()!, /stalled/);
});

test('output text is not operation identity and large payloads are ignored rather than malformed by truncation', () => {
  assert.equal(repairOperation(tool('x', { content: 'x'.repeat(65_000) }, 'started')), null);
  const first = tool('x', { file: 'a' }, 'completed');
  assert.equal(repairOperation(first), repairOperation({ ...first, toolCallId: 'another-id', output: 'a different log' } as RepairActivityEvent));
});

test('first output begins activity once, while the separate startup limit owns initial silence', () => {
  let now = 0;
  const monitor = createRepairActivityMonitor({ now: () => now, timeoutMs: 100, longToolTimeoutMs: 100,
    known: () => false, checkpoint: () => true });
  now = 1000;
  assert.equal(monitor.failure(), null);
  monitor.begin();
  now = 1090;
  monitor.begin();
  now = 1100;
  assert.match(monitor.failure()!, /stalled/, 'additional output never restarts the activity window');
});

test('a previously observed long command still receives bounded execution time after restart', () => {
  let now = 0;
  const monitor = createRepairActivityMonitor({ now: () => now, timeoutMs: 100, longToolTimeoutMs: 100,
    known: () => true, checkpoint: () => { throw new Error('known activity must not write again'); } });
  monitor.begin();
  now = 80;
  monitor.observe(tool('retest', { command: 'mvn test' }, 'started', { tool: 'Bash', toolClass: 'shell' }));
  now = 150;
  assert.equal(monitor.failure(), null);
  now = 180;
  assert.match(monitor.failure()!, /stalled/);
});
