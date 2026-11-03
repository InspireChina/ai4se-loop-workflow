import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';

test('authorizes before entering external executable handlers and retains real Direct result submission', async () => {
  const { createTask } = await import('./tasks');
  const { issueAgentCommandToken, runAgentCommand, readAgentCommandSubmission } = await import('./agent-command-drafts');
  const taskId = await createTask({ title: 'Executable handler proof', itemType: 'direct' });
  const delegation = (await inspectTaskDispatch(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId: `RUN-script-${taskId}`, delegation, prompt: 'Script interface proof' });
  const executionId = started.attempt.execution_id;
  const token = (await issueAgentCommandToken(executionId))!;
  const path = join(getConfiguredWorkspaceRoot(), '.omp', 'commands', 'direct-agent.cjs');
  const original = readFileSync(path, 'utf8');
  const proof = join(getConfiguredWorkspaceRoot(), 'handler-proof');
  const marker = `require('node:fs').writeFileSync(${JSON.stringify(proof)}, 'called');`;
  try {
    writeFileSync(path, original.replace('return runtime.runDirectCommand(invocation);', `${marker}\n    return runtime.runDirectCommand(invocation) + '\\nEXTERNAL_EXECUTE_PROOF';`));
    await assert.rejects(runAgentCommand({ executionId, token: 'invalid', args: ['direct', 'run'] }), /凭证无效/);
    assert.equal(existsSync(proof), false);
    const output = await runAgentCommand({ executionId, token, args: ['direct', 'run'] });
    assert.match(output, /EXTERNAL_EXECUTE_PROOF/);
    assert.equal(readFileSync(proof, 'utf8'), 'called');
    await runAgentCommand({ executionId, token, args: ['direct', 'submit', '--summary', 'Script output', '--result', '# Script result'] });
    assert.equal((await readAgentCommandSubmission(executionId))?.artifact?.content, '# Script result');
  } finally {
    writeFileSync(path, original);
    rmSync(proof, { force: true });
  }
});
