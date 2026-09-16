import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema, pauseTask, resumeTask } from './tasks';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { acquireResourceClaimInDb, activeResourceClaimInDb, releaseTaskResourceClaimsInDb, tryAcquireResourceClaimInDb } from './resource-claims';
import { activeExecutionProcessesInDb, attachExecutionProcessInDb, ExecutionProcessBarrierError,
  finishExecutionProcessInDb, prepareExecutionProcessInDb } from './execution-processes';
import { stopExecutionProcessesInDb } from '../infrastructure/execution-process-control';
import { executeDelegation } from '../infrastructure/delegation-execution';
import { createLangfuseTelemetry } from '../infrastructure/langfuse';
import { terminateProcessTree } from '../infrastructure/process-tree';
import { createProject } from './projects';
import { stopAgentRun } from '../infrastructure/agent-runner';
import { registerManagedProcessInDb } from '../infrastructure/managed-process-registry';
import { inspectProcessGroup, terminateProcessGroup } from '../infrastructure/process-tree';

async function source() {
  const db = await databaseConnection();
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Physical exit barrier', itemType: 'direct' }), taskId);
  const runId = `RUN-${randomUUID()}`;
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const { attempt } = await beginTestExecutionAttempt({ runId, delegation, prompt: 'Physical exit fixture' });
  const executionId = attempt.execution_id;
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId });
  const allocationId = prepareExecutionProcessInDb(db, executionId, process.pid, 7);
  return { db, taskId, runId, executionId, allocationId };
}

test('pause and logical claim release cannot unlock code before physical exit; resume waits for confirmation', async () => {
  const { db, taskId, executionId, allocationId } = await source();
  try {
    attachExecutionProcessInDb(db, allocationId, 4321, 'original-start');
    await pauseTask({ taskId });
    assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_task_id = ?').get(taskId), undefined);
    assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId, { releaseStale: false })?.owner_execution_id, executionId);
    await resumeTask({ taskId });
    const next = { resourceKey: 'code:workspace' as const, taskId, lane: 'control', executionId: 'new-source' };
    assert.equal(tryAcquireResourceClaimInDb(db, next), false);
    assert.equal((await inspectTaskDispatchEnvelope(taskId)).length, 0, 'planner must see barriers even when logical claims were deleted');
    assert.equal(finishExecutionProcessInDb(db, allocationId, false), false);
    assert.equal(tryAcquireResourceClaimInDb(db, next), false);
    assert.equal(finishExecutionProcessInDb(db, allocationId, true), true);
    assert.equal(finishExecutionProcessInDb(db, allocationId, true), false, 'duplicate close is idempotent');
    const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
    const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'After physical confirmation' });
    assert.equal(tryAcquireResourceClaimInDb(db, { ...next, executionId: started.attempt.execution_id }), true);
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('launch reservation atomically fences duplicate launches and cancelled sources cannot start', async () => {
  const { db, taskId, executionId, allocationId } = await source();
  try {
    assert.throws(() => prepareExecutionProcessInDb(db, executionId, process.pid, 7), ExecutionProcessBarrierError);
    assert.equal(activeExecutionProcessesInDb(db, (db.prepare('SELECT run_id FROM execution_attempts WHERE execution_id = ?')
      .get(executionId) as { run_id: string }).run_id).length, 1);
    finishExecutionProcessInDb(db, allocationId, true);
    assert.throws(() => prepareExecutionProcessInDb(db, executionId, process.pid, 7,
      { runId: 'other-run', taskId: 'other-task' }), ExecutionProcessBarrierError);
    db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(executionId);
    assert.throws(() => prepareExecutionProcessInDb(db, executionId, process.pid, 7), ExecutionProcessBarrierError);
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('host cleanup works without business Runner; failed termination retains the durable barrier across retries', async () => {
  const { db, taskId, executionId, runId, allocationId } = await source();
  try {
    attachExecutionProcessInDb(db, allocationId, 4322, 'owned-start');
    db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(executionId);
    releaseTaskResourceClaimsInDb(db, taskId);
    const control = { inspect: async (pid: number) => ({ pid, startMarker: 'owned-start' }), terminate: async () => false };
    assert.equal((await stopExecutionProcessesInDb(db, { runId }, control)).length, 1);
    assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId)?.owner_execution_id, executionId);
    assert.equal((await stopExecutionProcessesInDb(db, { runId }, { ...control, terminate: async () => true })).length, 0);
    assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId), undefined);
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 0);
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('unregistered launch never silently clears physical ownership', async () => {
  const { db, taskId, runId, allocationId } = await source();
  try {
    let kills = 0;
    const control = { inspect: async (pid: number) => ({ pid, startMarker: 'different-start' }),
      terminate: async () => { kills++; return true; } };
    assert.equal((await stopExecutionProcessesInDb(db, { runId }, control)).length, 1);
    assert.equal(kills, 0);
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 1);
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('reused PID never gets killed or silently clears physical ownership', async () => {
  const { db, taskId, runId, allocationId } = await source();
  try {
    let kills = 0;
    const control = { inspect: async (pid: number) => ({ pid, startMarker: 'different-start' }),
      terminate: async () => { kills++; return true; } };
    attachExecutionProcessInDb(db, allocationId, 4323, 'old-start');
    assert.equal((await stopExecutionProcessesInDb(db, { runId }, control)).length, 1);
    assert.equal((await stopExecutionProcessesInDb(db, { runId }, {
      ...control, inspect: async () => { throw new Error('OS identity helper unavailable'); },
    })).length, 1);
    assert.equal(kills, 0);
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 1);
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('physical barriers are persisted across database reconnects and do not block unrelated projects', async () => {
  const { db, taskId, executionId, allocationId } = await source();
  const reopened = new Database(db.name);
  let secondTaskId: string | undefined;
  try {
    releaseTaskResourceClaimsInDb(db, taskId);
    assert.equal(activeResourceClaimInDb(reopened, 'code:workspace', taskId)?.owner_execution_id, executionId);
    const workspaceRoot = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
    mkdirSync(workspaceRoot, { recursive: true });
    const projectId = await createProject({ name: 'Independent barrier project', workspaceRoot });
    secondTaskId = `REQ-${randomUUID()}`;
    createTaskInDb(db, createTaskSchema.parse({ title: 'Unrelated work', itemType: 'direct', projectId }), secondTaskId);
    assert.equal(tryAcquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId: secondTaskId, lane: 'control' }), true);
    assert.equal(activeResourceClaimInDb(reopened, 'code:workspace', taskId)?.owner_execution_id, executionId);
  } finally {
    reopened.close();
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
    if (secondTaskId) releaseTaskResourceClaimsInDb(db, secondTaskId);
  }
});

test('real CLI pause and immediate resume cannot start another writer before cancellation completes', { timeout: 10_000 }, async () => {
  const { db, taskId, executionId, runId, allocationId } = await source();
  finishExecutionProcessInDb(db, allocationId, true); // The fixture reservation did not spawn a child.
  const retryConsumedBefore = (db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?')
    .get(executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed;
  const cancellation = new AbortController();
  let childPid = 0;
  try {
    const result = await executeDelegation({
      executionId, runId, prompt: 'Offline physical ownership integration', workspaceRoot: process.cwd(),
      executor: { id: 'codex', label: 'Offline CLI', command: process.execPath, promptMode: 'argument',
        buildArgs: () => ['-e', 'console.log("ready");setInterval(()=>{},1000)'], formatCommand: () => 'node offline fixture',
        parseStdout: () => null, parseStderr: () => null },
      context: { agent: 'direct-agent', taskId, storyIndex: null, pipeline: 'direct', lane: 'control' }, executionOptions: {},
      description: 'Physical pause and resume', telemetry: createLangfuseTelemetry({ env: {} }), appendLog: async () => {},
      maxRuntimeMs: 5_000, idleTimeoutMs: 5_000, startupTimeoutMs: 5_000, cancellationSignal: cancellation.signal,
      processes: {
        register: async (_runId, pid) => {
          childPid = pid;
          assert.equal(activeExecutionProcessesInDb(db, runId)[0].pid, pid);
          await pauseTask({ taskId });
          await resumeTask({ taskId });
          assert.doesNotThrow(() => process.kill(pid, 0), 'real old CLI is still alive while claims are released');
          assert.equal((await inspectTaskDispatchEnvelope(taskId)).length, 0);
          assert.equal(tryAcquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId: 'next-writer' }), false);
          cancellation.abort();
          return `test-${pid}`;
        },
        terminate: terminateProcessTree,
        markExited: async () => {},
      },
    });
    assert.equal(result.cancelled, true);
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 0);
    assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId), undefined);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal((db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?')
      .get(executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed, retryConsumedBefore);
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ } }
    for (const row of activeExecutionProcessesInDb(db, runId)) finishExecutionProcessInDb(db, row.allocation_id, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('root close cannot clear a barrier when whole-tree termination remains unconfirmed', { timeout: 10_000 }, async () => {
  const { db, taskId, executionId, runId, allocationId } = await source();
  finishExecutionProcessInDb(db, allocationId, true);
  const cancellation = new AbortController();
  let childPid = 0;
  let exitSettlements = 0;
  try {
    await assert.rejects(executeDelegation({
      executionId, runId, prompt: 'Unconfirmed descendant fixture', workspaceRoot: process.cwd(),
      executor: { id: 'codex', label: 'Offline CLI', command: process.execPath, promptMode: 'argument',
        buildArgs: () => ['-e', 'setInterval(()=>{},1000)'], formatCommand: () => 'node offline fixture',
        parseStdout: () => null, parseStderr: () => null },
      context: { agent: 'direct-agent', taskId, storyIndex: null, pipeline: 'direct', lane: 'control' }, executionOptions: {},
      description: 'Root close is insufficient', telemetry: createLangfuseTelemetry({ env: {} }), appendLog: async () => {},
      maxRuntimeMs: 5_000, idleTimeoutMs: 5_000, startupTimeoutMs: 5_000, cancellationSignal: cancellation.signal,
      processes: {
        register: async (_runId, pid) => { childPid = pid; cancellation.abort(); return `test-${pid}`; },
        terminate: async (pid, timeoutMs) => {
          await terminateProcessTree(pid, timeoutMs);
          return false; // Root exited, but the adapter cannot confirm all descendants.
        },
        markExited: async () => { exitSettlements++; },
      },
    }), /进程树未确认退出/);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(exitSettlements, 0);
    releaseTaskResourceClaimsInDb(db, taskId);
    assert.equal(activeExecutionProcessesInDb(db, runId)[0].status, 'terminating');
    assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId)?.owner_execution_id, executionId);
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ } }
    for (const row of activeExecutionProcessesInDb(db, runId)) finishExecutionProcessInDb(db, row.allocation_id, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('an uncertain allocation does not prevent stopping other known CLIs and the Runner', async () => {
  const { db, taskId, runId, allocationId } = await source();
  try {
    for (const [kind, pid] of [['agent-cli', 54321], ['agent-runner', 54322]] as const) {
      registerManagedProcessInDb(db, { processId: randomUUID(), supervisionToken: 7,
        processKind: kind, pid, processStartMarker: 'fixture-only-never-signal', runId });
    }
    const stopped: number[] = [];
    await assert.rejects(stopAgentRun(runId, {
      terminate: async (pid) => { stopped.push(pid); return true; }, inspectCommand: async () => '',
    }), /退出未确认/);
    assert.deepEqual(stopped, [54321, 54322]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM loop_managed_processes WHERE run_id = ? AND status = 'running'")
      .get(runId) as { count: number }).count, 0);
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 1, 'unknown ownership still fences writes');
  } finally {
    finishExecutionProcessInDb(db, allocationId, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});

test('normal successful CLI close cleans its isolated descendants before releasing the physical barrier', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const { db, taskId, executionId, runId, allocationId } = await source();
  finishExecutionProcessInDb(db, allocationId, true);
  const descendantProgram = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);';
  const program = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => {
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:String(child.pid)}}));
      process.exit(0);
    });
  `;
  let groupId = 0;
  try {
    const result = await executeDelegation({
      executionId, runId, prompt: 'Offline successful root with orphan', workspaceRoot: process.cwd(),
      executor: { id: 'codex', label: 'Offline CLI', command: process.execPath, promptMode: 'argument',
        buildArgs: () => ['-e', program], formatCommand: () => 'node offline group fixture', parseStdout: () => null, parseStderr: () => null },
      context: { agent: 'direct-agent', taskId, storyIndex: null, pipeline: 'direct', lane: 'control' }, executionOptions: {},
      description: 'Successful CLI orphan cleanup', telemetry: createLangfuseTelemetry({ env: {} }), appendLog: async () => {},
      maxRuntimeMs: 10_000, idleTimeoutMs: 10_000, startupTimeoutMs: 10_000,
    });
    const row = db.prepare('SELECT pid,process_group_id,status FROM execution_processes WHERE execution_id = ? AND pid IS NOT NULL')
      .get(executionId) as { pid: number; process_group_id: number; status: string };
    groupId = row.process_group_id;
    assert.equal(groupId, row.pid);
    assert.equal(row.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.ok(Number(result.finalText) > 0);
    assert.deepEqual(await inspectProcessGroup(groupId), []);
    assert.throws(() => process.kill(Number(result.finalText), 0), { code: 'ESRCH' });
    assert.equal(activeExecutionProcessesInDb(db, runId).length, 0);
  } finally {
    if (!groupId) groupId = (db.prepare('SELECT process_group_id FROM execution_processes WHERE execution_id = ? AND process_group_id IS NOT NULL')
      .get(executionId) as { process_group_id: number } | undefined)?.process_group_id || 0;
    if (groupId) await terminateProcessGroup(groupId, 7_000);
    for (const row of activeExecutionProcessesInDb(db, runId)) finishExecutionProcessInDb(db, row.allocation_id, true);
    releaseTaskResourceClaimsInDb(db, taskId);
  }
});
