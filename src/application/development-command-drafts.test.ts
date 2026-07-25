import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const { gitHead } = await import('../infrastructure/git');
  const { paths } = await import('../infrastructure/database');
  const started = await beginExecutionAttempt({
    runId: `RUN-development-${suffix}`,
    delegation,
    prompt: 'progressive development prompt',
    baseCommit: gitHead(paths.root),
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function developmentDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask, saveStorySpec } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();
  const taskId = await createTask({
    title,
    description: '用户需要在结果页看到一个明确的完成状态。',
  });
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'ready for dev',
          current_subagent = 'dev-agent', total_stories = 1,
          analysis_index = 1, spec_resolved_index = 1,
          dev_index = 0, test_index = 0,
          next_step = '实现结果页完成状态'
      WHERE task_id = ?
    `).run(taskId);
    db.prepare(`
      INSERT INTO stories(task_id, story_index, title, directory)
      VALUES(?, 1, '用户看到结果页完成状态', 'story-001')
    `).run(taskId);
  })();
  await saveStorySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: {
      goal: '用户可以识别结果已经完成',
      scope: { included: ['结果页完成状态'], excluded: ['任务调度'] },
      behaviors: [{ scenario: '结果已生成', expected: '页面展示完成状态' }],
      decisions: [{
        key: 'status-label',
        decision: '使用现有完成状态文案',
        rationale: '保持产品术语一致',
        source: 'convention',
      }],
      decisionTree: [{
        key: 'status-label',
        question: '完成状态使用什么文案？',
        impact: '影响用户可观察文案',
        options: [
          { id: 'existing', label: '现有文案', consequences: ['保持一致'] },
          { id: 'new', label: '新文案', consequences: ['需要更新其他页面'] },
        ],
        status: 'resolved_from_context',
        selectedOption: 'existing',
        source: 'convention',
        evidence: ['仓库已有相同状态组件'],
      }],
      ambiguities: [],
      acceptanceCriteria: [{
        id: 'AC-status',
        description: '结果完成后页面展示完成状态',
        oracle: '页面存在可识别的完成状态',
      }],
      verificationPlan: [{
        criterionId: 'AC-status',
        kind: 'command',
        instruction: '运行状态组件测试',
        command: 'npm test',
      }],
      dependencies: [],
      changeBudget: {
        capabilities: ['结果状态展示'],
        paths: ['src/result-status.ts'],
      },
    },
  });
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'dev-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordExistingImplementation(executionId: string, token: string) {
  await command(executionId, token, [
    'implementation', 'summary', 'set', '--text',
    '走查确认现有结果状态组件已经覆盖当前规格',
  ]);
  await command(executionId, token, [
    'implementation', 'assessment', 'set', '--mode', 'existing',
  ]);
  await command(executionId, token, [
    'implementation', 'notes', 'set', '--text',
    '现有组件在结果生成后展示完成状态，无需修改代码',
  ]);
  await command(executionId, token, [
    'implementation', 'criterion', 'upsert', '--key', 'AC-status',
    '--status', 'covered', '--evidence', '状态组件测试覆盖完成结果分支',
  ]);
  await command(executionId, token, [
    'implementation', 'test', 'upsert', '--key', 'status-component',
    '--command', 'npm test -- result-status', '--passed', 'true',
    '--summary', '完成状态分支测试通过',
  ]);
}

test('development agent progressively proves an existing implementation without manufacturing a commit', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await developmentDelegation('渐进式开发走查');
  const started = await begin(delegation, `${taskId}-existing`);

  await assert.rejects(
    command(started.executionId, started.token!, [
      'implementation', 'summary', 'set', '--text', '不能跳过 status',
    ]),
    /implementation status/,
  );
  const initial = await command(started.executionId, started.token!, ['implementation', 'status']);
  assert.match(initial, /开发实现草稿 v1/);
  assert.match(initial, /AC-status.*尚未记录/);
  await recordExistingImplementation(started.executionId, started.token!);
  assert.equal(
    await command(started.executionId, started.token!, ['implementation', 'validate']),
    '开发实现草稿结构校验通过。',
  );
  await command(started.executionId, started.token!, ['implementation', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.deepEqual(result?.changedFiles, []);
  assert.equal(result?.tests?.[0]?.passed, true);
  assert.match(result?.artifact?.content || '', /现有实现已满足规格/);

  await applyAgentResult(`RUN-development-existing-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'test-agent');
});

test('development runtime input keeps a stable request key and answer across resume', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { taskId, delegation } = await developmentDelegation('开发运行信息恢复');
  const first = await begin(delegation, `${taskId}-input`);
  await command(first.executionId, first.token!, ['implementation', 'status']);
  await command(first.executionId, first.token!, [
    'implementation', 'summary', 'set', '--text', '缺少本地预览入口，暂时无法验证页面行为',
  ]);
  await command(first.executionId, first.token!, [
    'implementation', 'runtime-input', 'upsert', '--key', 'preview-url',
    '--title', '本地预览地址', '--question', '应使用哪个已经配置好的本地预览地址？',
    '--why', '验收标准需要检查页面完成状态', '--recommendation', '使用现有开发服务器地址',
  ]);
  await command(first.executionId, first.token!, ['implementation', 'request-input']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.runtimeInputs[0]?.key, 'preview-url');
  await applyAgentResult(`RUN-development-input-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) => item.request_key === 'preview-url');
  assert.ok(request);
  await answerRuntimeInput({
    taskId,
    requestId: request!.request_id,
    answer: '使用 http://localhost:3001。',
  });
  await submitRuntimeInputs(taskId);
  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'dev-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['implementation', 'status']);
  assert.match(restored, /开发实现草稿 v2/);
  assert.match(restored, /preview-url.*已回答=使用 http:\/\/localhost:3001/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'implementation', 'runtime-input', 'remove', '--key', 'preview-url',
    ]),
    /必须保留原 request key/,
  );
  await recordExistingImplementation(resumed.executionId, resumed.token!);
  await command(resumed.executionId, resumed.token!, ['implementation', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  await applyAgentResult(`RUN-development-resume-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);
  detail = await getTask(taskId);
  assert.equal(
    detail?.runtimeInputs.find((item) => item.request_key === 'preview-url')?.status,
    'resolved',
  );
  assert.equal(detail?.task.dev_index, 1);
});

test('development changed mode rejects a missing real commit before terminal submission', async () => {
  const { taskId, delegation } = await developmentDelegation('开发提交校验');
  const started = await begin(delegation, `${taskId}-commit`);
  await command(started.executionId, started.token!, ['implementation', 'status']);
  await command(started.executionId, started.token!, [
    'implementation', 'summary', 'set', '--text', '补齐结果状态实现',
  ]);
  await command(started.executionId, started.token!, [
    'implementation', 'assessment', 'set', '--mode', 'changed',
  ]);
  await command(started.executionId, started.token!, [
    'implementation', 'notes', 'set', '--text', '增加完成状态渲染',
  ]);
  await command(started.executionId, started.token!, [
    'implementation', 'criterion', 'upsert', '--key', 'AC-status',
    '--status', 'covered', '--evidence', '新增完成状态分支',
  ]);
  await command(started.executionId, started.token!, [
    'implementation', 'change', 'upsert', '--path', 'src/result-status.ts',
    '--summary', '增加完成状态渲染',
  ]);
  await command(started.executionId, started.token!, [
    'implementation', 'test', 'upsert', '--key', 'status-component',
    '--command', 'npm test -- result-status', '--passed', 'true',
    '--summary', '测试通过',
  ]);
  await assert.rejects(
    command(started.executionId, started.token!, ['implementation', 'complete']),
    /必须记录 commit|当前 HEAD 与 execution 基线相同/,
  );
});
