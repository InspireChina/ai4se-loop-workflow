import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupportedAgentExecutor, SUPPORTED_AGENT_EXECUTORS } from '../domain/agent-executor';
import { runSystemAssistancePrompt } from '../infrastructure/system-assistance-executor';
import { runTaskContextChatTurn } from '../infrastructure/task-context-chat-executor';
import { AGENT_EXECUTOR_OPTIONS, getAgentExecutorSettings, getFlowAgentDefaultRuntimeSettings, setAgentExecutorSettings, setFlowAgentDefaultRuntimeSettings } from './project-settings';

test('DJI accepts OMP and rejects other runtimes before launching processes', async () => {
  assert.deepEqual(SUPPORTED_AGENT_EXECUTORS, ['omp']);
  assert.deepEqual(AGENT_EXECUTOR_OPTIONS.map((item) => item.id), ['omp']);
  assert.doesNotThrow(() => assertSupportedAgentExecutor('omp'));
  for (const id of ['cursor', 'codex', 'claude'] as const) {
    assert.throws(() => assertSupportedAgentExecutor(id), /仅支持 OMP/);
    await assert.rejects(() => runSystemAssistancePrompt({ executorId: id as never, executionOptions: {}, prompt: 'prompt' }), /仅支持 OMP/);
    await assert.rejects(() => runTaskContextChatTurn({ executor: id } as unknown as Parameters<typeof runTaskContextChatTurn>[0]), /仅支持 OMP/);
    await assert.rejects(() => setAgentExecutorSettings({ executorId: id }));
    await assert.rejects(() => setFlowAgentDefaultRuntimeSettings({ executorId: id }));
  }
  assert.equal((await getAgentExecutorSettings()).executorId, 'omp');
  assert.equal((await getFlowAgentDefaultRuntimeSettings()).executorId, 'omp');
});

test('stored runtime settings contain only OMP fields', async () => {
  const { appDatabaseConnection } = await import('../infrastructure/database');
  const db=appDatabaseConnection();
  const columns=db.prepare('PRAGMA table_info(global_runtime_configurations)').all() as {name:string}[];
  assert.ok(columns.some(column=>column.name==='omp_model'));
  assert.ok(columns.some(column=>column.name==='omp_thinking'));
  assert.ok(columns.every(column=>!column.name.startsWith('codex_') && column.name!=='claude_model'));
  const settings=await getFlowAgentDefaultRuntimeSettings();
  assert.ok(!('codexModel' in settings));
  assert.ok(!('claudeModel' in settings));
});
