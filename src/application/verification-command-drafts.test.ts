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
  const started = await beginExecutionAttempt({
    runId: `RUN-verification-${suffix}`,
    delegation,
    prompt: 'progressive verification prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function verificationDelegation(title: string) {
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
    description: '用户需要验证结果页完成状态。',
  });
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'in dev',
          current_subagent = 'test-agent', total_stories = 1,
          analysis_index = 1, spec_resolved_index = 1,
          dev_index = 1, test_index = 0,
          next_step = '验证结果页完成状态'
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
    item.agent === 'test-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordPassedVerification(executionId: string, token: string) {
  await command(executionId, token, [
    'verification', 'summary', 'set', '--text',
    '独立验证确认完成状态符合当前规格，回归检查通过',
  ]);
  await command(executionId, token, [
    'verification', 'criterion', 'upsert', '--key', 'AC-status',
    '--status', 'passed', '--method', 'command',
    '--evidence', '状态组件黑盒调用返回预期完成文案',
  ]);
  await command(executionId, token, [
    'verification', 'check', 'upsert', '--key', 'result-status-suite',
    '--kind', 'command', '--instruction', '运行状态组件完整测试',
    '--command', 'npm test -- result-status', '--passed', 'true',
    '--exit-code', '0', '--summary', '完成与未完成分支均通过',
  ]);
}

test('verification agent progressively records independent evidence and advances after pass', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('渐进式独立验证');
  const started = await begin(delegation, `${taskId}-pass`);

  await assert.rejects(
    command(started.executionId, started.token!, [
      'verification', 'summary', 'set', '--text', '不能跳过 status',
    ]),
    /verification status/,
  );
  const initial = await command(started.executionId, started.token!, ['verification', 'status']);
  assert.match(initial, /验证草稿 v1/);
  assert.match(initial, /AC-status.*尚未记录/);
  await recordPassedVerification(started.executionId, started.token!);
  await command(started.executionId, started.token!, ['verification', 'pass']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.verdict, 'passed');
  assert.equal(result?.tests?.[0]?.passed, true);
  assert.match(result?.artifact?.content || '', /AC-status.*passed/);

  await applyAgentResult(`RUN-verification-pass-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.test_index, 1);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'review-agent');
});

test('verification failure classifies implementation evidence and deterministically rewinds to dev', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('验证失败自动回流');
  const started = await begin(delegation, `${taskId}-fail`);
  await command(started.executionId, started.token!, ['verification', 'status']);
  await command(started.executionId, started.token!, [
    'verification', 'summary', 'set', '--text',
    '完成状态仍显示旧文案，独立回归失败',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'criterion', 'upsert', '--key', 'AC-status',
    '--status', 'failed', '--method', 'command',
    '--evidence', 'resultStatus(true) 实际返回旧文案',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'check', 'upsert', '--key', 'result-status-suite',
    '--kind', 'command', '--instruction', '运行状态组件完整测试',
    '--command', 'npm test -- result-status', '--passed', 'false',
    '--exit-code', '1', '--summary', '完成分支断言失败',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'failure', 'set', '--kind', 'implementation',
    '--expected', '完成结果显示已完成', '--actual', '完成结果仍显示处理完成',
  ]);
  await command(started.executionId, started.token!, ['verification', 'fail']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.verdict, 'failed');
  assert.equal(result?.failureKind, 'implementation');
  assert.equal(result?.rewindTo, 'dev');
  assert.equal(result?.rewindDeliveryUnit, 1);

  await applyAgentResult(`RUN-verification-fail-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.recoveryItems[0]?.target_stage, 'dev');
  assert.equal(detail?.recoveryItems[0]?.status, 'pending');
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'dev-agent');
});

test('verification runtime input preserves one stable request key and resumes the same draft', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('验证运行信息恢复');
  const first = await begin(delegation, `${taskId}-input`);
  await command(first.executionId, first.token!, ['verification', 'status']);
  await command(first.executionId, first.token!, [
    'verification', 'summary', 'set', '--text', '缺少可用的预览地址，无法完成黑盒验证',
  ]);
  await command(first.executionId, first.token!, [
    'verification', 'runtime-input', 'upsert', '--key', 'preview-url',
    '--title', '预览地址', '--question', '应使用哪个已经配置好的非敏感预览地址？',
    '--why', '需要从用户可观察入口验证完成状态', '--recommendation', '使用现有本地开发服务器地址',
  ]);
  await command(first.executionId, first.token!, ['verification', 'request-input']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.runtimeInputs[0]?.key, 'preview-url');
  await applyAgentResult(`RUN-verification-input-${taskId}`, delegation, pending!, {
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
    item.agent === 'test-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['verification', 'status']);
  assert.match(restored, /验证草稿 v2/);
  assert.match(restored, /preview-url.*已回答=使用 http:\/\/localhost:3001/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'verification', 'runtime-input', 'remove', '--key', 'preview-url',
    ]),
    /必须保留原 request key/,
  );
  await recordPassedVerification(resumed.executionId, resumed.token!);
  await command(resumed.executionId, resumed.token!, ['verification', 'pass']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  await applyAgentResult(`RUN-verification-resume-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);
  detail = await getTask(taskId);
  assert.equal(
    detail?.runtimeInputs.find((item) => item.request_key === 'preview-url')?.status,
    'resolved',
  );
  assert.equal(detail?.task.test_index, 1);
});

test('verification block preserves environment evidence without misrouting to dev', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await verificationDelegation('验证环境阻塞归因');
  const started = await begin(delegation, `${taskId}-block`);
  await command(started.executionId, started.token!, ['verification', 'status']);
  await command(started.executionId, started.token!, [
    'verification', 'summary', 'set', '--text', '浏览器环境无法启动，无法取得用户可观察证据',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'criterion', 'upsert', '--key', 'AC-status',
    '--status', 'not-tested', '--method', 'browser',
    '--evidence', '浏览器启动失败，尚未观察产品行为',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'check', 'upsert', '--key', 'browser-start',
    '--kind', 'browser', '--instruction', '启动预览并打开结果页',
    '--passed', 'false', '--summary', '浏览器运行环境不可用',
  ]);
  await command(started.executionId, started.token!, [
    'verification', 'failure', 'set', '--kind', 'environment',
    '--expected', '可启动浏览器访问预览页面', '--actual', '浏览器运行环境启动失败',
  ]);
  await command(started.executionId, started.token!, ['verification', 'block']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'failed');
  assert.equal(result?.failureKind, 'environment');
  assert.equal(result?.rewindTo, undefined);
});
