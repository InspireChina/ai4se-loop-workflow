import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';

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
    prompt: `two-phase independent verification prompt ${suffix}`,
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function verificationDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask, saveDeliverySpec } = await import('./tasks');
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
  await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: deliverySpecFixture({
      handoff: {
        implementationGuidance: '复用现有结果状态组件。',
        guardrails: [{
          key: 'pending-visible',
          content: '未完成状态仍需保持可见',
          rationale: '不能因完成态改动破坏相邻业务状态',
        }],
        verificationFocus: [{
          key: 'AC-status',
          expected: '结果完成后页面展示完成状态',
          oracle: '页面存在可识别的完成状态',
        }],
      },
    }),
  });
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'test-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function upsertFrontendPlan(executionId: string, token: string, key = 'result-page') {
  return command(executionId, token, [
    'verification', 'plan', 'upsert',
    '--key', key,
    '--channel', 'frontend',
    '--title', '用户从结果页观察完成与未完成状态',
    '--setup', '应用已启动，存在一条完成结果和一条未完成结果',
    '--steps', '打开 /results，并分别查看两条结果',
    '--expected', '完成结果展示完成状态，未完成结果仍保持可识别',
    '--covers', 'unit-acceptance,focus:AC-status,guardrail:pending-visible',
  ]);
}

async function recordResult(
  executionId: string,
  token: string,
  input: {
    key?: string;
    status: 'passed' | 'failed' | 'blocked';
    evidence: string;
    kind?: 'implementation' | 'specification' | 'environment' | 'inconclusive';
    actual?: string;
  },
) {
  const args = [
    'verification', 'result', 'record',
    '--key', input.key || 'result-page',
    '--status', input.status,
    '--evidence', input.evidence,
  ];
  if (input.kind) args.push('--kind', input.kind);
  if (input.actual) args.push('--actual', input.actual);
  return command(executionId, token, args);
}

test('verification freezes a complete frontend-led plan and advances from recorded results', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('两阶段前端独立验证');
  const started = await begin(delegation, `${taskId}-pass`);

  await assert.rejects(
    upsertFrontendPlan(started.executionId, started.token!),
    /verification status/,
  );
  const initial = await command(started.executionId, started.token!, ['verification', 'status']);
  assert.match(initial, /阶段：规划测试计划/);
  assert.match(initial, /unit-acceptance.*未覆盖/);
  assert.match(initial, /focus:AC-status.*未覆盖/);
  assert.match(initial, /guardrail:pending-visible.*未覆盖/);

  await command(started.executionId, started.token!, [
    'verification', 'plan', 'upsert',
    '--key', 'api-only',
    '--channel', 'api',
    '--title', '读取结果状态 API',
    '--setup', '服务已启动，并存在一条完成结果',
    '--steps', '请求 GET /api/results/1',
    '--expected', '返回完成状态',
    '--covers', 'unit-acceptance,focus:AC-status,guardrail:pending-visible',
  ]);
  await assert.rejects(
    command(started.executionId, started.token!, ['verification', 'plan', 'freeze']),
    /unit-acceptance 必须由至少一个 frontend 场景覆盖/,
  );
  await command(started.executionId, started.token!, [
    'verification', 'plan', 'dismiss', '--key', 'api-only',
  ]);
  await upsertFrontendPlan(started.executionId, started.token!);
  await command(started.executionId, started.token!, ['verification', 'plan', 'freeze']);

  await assert.rejects(
    upsertFrontendPlan(started.executionId, started.token!),
    /不能修改既有场景/,
  );
  await recordResult(started.executionId, started.token!, {
    status: 'passed',
    evidence: '从浏览器打开结果页，完成与未完成状态均符合可观察期望',
  });
  const ready = await command(started.executionId, started.token!, ['verification', 'status']);
  assert.match(ready, /所有计划场景均已记录结果/);
  await command(started.executionId, started.token!, [
    'verification', 'complete',
    '--risk', '本轮只覆盖结果页相关业务状态，不代表全站视觉回归',
  ]);

  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.verdict, 'passed');
  assert.equal(result?.tests?.[0]?.passed, true);
  assert.match(result?.artifact?.content || '', /result-page · frontend · passed/);
  assert.match(result?.artifact?.content || '', /准备：应用已启动，存在一条完成结果和一条未完成结果/);
  assert.match(result?.artifact?.content || '', /测试步骤：打开 \/results，并分别查看两条结果/);
  assert.match(result?.artifact?.content || '', /unit-acceptance/);
  assert.match(result?.artifact?.content || '', /不代表全站视觉回归/);

  await applyAgentResult(`RUN-verification-pass-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.test_index, 1);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'review-agent');
});

test('verification help explains the compact two-phase command surface', async () => {
  const { taskId, delegation } = await verificationDelegation('验证命令专题帮助');
  const started = await begin(delegation, `${taskId}-help`);
  const all = await command(started.executionId, started.token!, ['help']);
  assert.match(all, /verification plan upsert/);
  assert.match(all, /--setup <前置条件与测试数据> --steps <入口与测试动作>/);
  assert.match(all, /verification plan freeze/);
  assert.match(all, /verification result record/);
  assert.match(all, /verification complete \[--risk/);
  assert.match(all, /verification request-input --key/);
  assert.doesNotMatch(all, /--preconditions|--test-data|--entry|--actions/);
  assert.doesNotMatch(all, /verification (?:criterion|check|failure|recovery|runtime-input|risk record|pass|fail|block)/);

  const plan = await command(started.executionId, started.token!, ['help', 'plan']);
  assert.match(plan, /frontend 场景覆盖真实业务闭环/);
  assert.match(plan, /API 场景可以补充业务证据或形成反例/);
  const execute = await command(started.executionId, started.token!, ['help', 'execute']);
  assert.match(execute, /implementation\/specification/);
  assert.match(execute, /environment\/inconclusive/);
  const input = await command(started.executionId, started.token!, ['help', 'input']);
  assert.match(input, /必要资源无法自行取得/);
  const finish = await command(started.executionId, started.token!, ['help', 'finish']);
  assert.match(finish, /Harness 只校验阶段、前端最低覆盖和结果完整性/);

  await command(started.executionId, started.token!, ['verification', 'status']);
  await assert.rejects(
    command(started.executionId, started.token!, [
      'verification', 'plan', 'upsert',
      '--key', 'legacy-shape',
      '--channel', 'frontend',
      '--title', '旧参数形态',
      '--preconditions', '应用已启动',
      '--test-data', '一条结果',
      '--entry', '/results',
      '--actions', '打开页面',
      '--expected', '展示结果',
      '--covers', 'unit-acceptance',
    ]),
    /缺少 --setup/,
  );
});

test('verification permits an API supplement but derives implementation failure from results', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('API 补充与实现失败归因');
  const started = await begin(delegation, `${taskId}-fail`);
  await command(started.executionId, started.token!, ['verification', 'status']);
  await upsertFrontendPlan(started.executionId, started.token!);
  await command(started.executionId, started.token!, [
    'verification', 'plan', 'upsert',
    '--key', 'result-api',
    '--channel', 'api',
    '--title', '结果状态接口保持业务语义',
    '--setup', '服务已启动，并存在一条完成结果',
    '--steps', '请求 GET /api/results/1 并读取 status',
    '--expected', 'status 为 completed',
    '--covers', 'focus:AC-status',
  ]);
  await command(started.executionId, started.token!, ['verification', 'plan', 'freeze']);
  await recordResult(started.executionId, started.token!, {
    status: 'failed',
    kind: 'implementation',
    evidence: '浏览器真实页面仍显示旧的处理中状态',
    actual: '完成结果仍展示处理中',
  });
  await recordResult(started.executionId, started.token!, {
    key: 'result-api',
    status: 'passed',
    evidence: '接口返回 completed，与业务期望一致',
  });
  await command(started.executionId, started.token!, ['verification', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.verdict, 'failed');
  assert.equal(result?.failureKind, 'implementation');
  assert.equal(result?.rewindTo, 'dev');
  assert.equal(result?.rewindDeliveryUnit, 1);
  assert.match(result?.summary || '', /1 个场景发现产品行为偏差/);

  await applyAgentResult(`RUN-verification-fail-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.recoveryItems[0]?.target_stage, 'dev');
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'dev-agent');
});

test('verification derives a block when required frontend resources are unavailable', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await verificationDelegation('验证环境资源阻塞');
  const started = await begin(delegation, `${taskId}-block`);
  await command(started.executionId, started.token!, ['verification', 'status']);
  await upsertFrontendPlan(started.executionId, started.token!);
  await command(started.executionId, started.token!, ['verification', 'plan', 'freeze']);
  await recordResult(started.executionId, started.token!, {
    status: 'blocked',
    kind: 'environment',
    evidence: '尝试启动并访问项目预览入口，浏览器无法连接',
    actual: '项目没有可启动的前端预览环境',
  });
  await command(started.executionId, started.token!, ['verification', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'failed');
  assert.equal(result?.verdict, 'failed');
  assert.equal(result?.failureKind, 'environment');
  assert.equal(result?.rewindTo, undefined);
});

test('verification runtime input resumes the same frozen plan and partial results', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('验证运行资源恢复');
  const first = await begin(delegation, `${taskId}-input`);
  await command(first.executionId, first.token!, ['verification', 'status']);
  await upsertFrontendPlan(first.executionId, first.token!);
  await command(first.executionId, first.token!, [
    'verification', 'plan', 'upsert',
    '--key', 'preview-health',
    '--channel', 'api',
    '--title', '预览服务健康检查',
    '--setup', '取得预览地址',
    '--steps', '请求 GET /health 健康检查',
    '--expected', '返回成功状态',
    '--covers', 'focus:AC-status',
  ]);
  await command(first.executionId, first.token!, ['verification', 'plan', 'freeze']);
  await recordResult(first.executionId, first.token!, {
    key: 'preview-health',
    status: 'passed',
    evidence: '已配置的默认健康检查地址响应成功',
  });
  await command(first.executionId, first.token!, [
    'verification', 'request-input',
    '--key', 'preview-url',
    '--title', '前端预览地址',
    '--question', '应使用哪个已部署的非敏感前端预览地址？',
    '--why', '需要从真实前端入口完成黑盒测试',
    '--recommendation', '提供当前测试环境的预览 URL',
  ]);
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
  assert.match(restored, /阶段：逐项执行测试/);
  assert.match(restored, /执行结果：1\/2/);
  assert.match(restored, /preview-url.*已回答=使用 http:\/\/localhost:3001/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'verification', 'request-input',
      '--key', 'preview-url',
      '--title', '前端预览地址',
      '--question', '重复询问同一个地址？',
      '--why', '不应重复',
      '--recommendation', '消费已有回答',
    ]),
    /已回答/,
  );
  await recordResult(resumed.executionId, resumed.token!, {
    status: 'passed',
    evidence: '在用户提供的预览地址完成前端黑盒验证',
  });
  await command(resumed.executionId, resumed.token!, ['verification', 'complete']);
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

test('a later verification cycle reuses a matching frozen plan but clears old results', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await verificationDelegation('验证计划跨轮复用');
  const first = await begin(delegation, `${taskId}-cycle-one`);
  await command(first.executionId, first.token!, ['verification', 'status']);
  await upsertFrontendPlan(first.executionId, first.token!);
  await command(first.executionId, first.token!, ['verification', 'plan', 'freeze']);
  await recordResult(first.executionId, first.token!, {
    status: 'failed',
    kind: 'implementation',
    evidence: '页面仍显示旧状态',
    actual: '页面未展示完成',
  });
  await command(first.executionId, first.token!, ['verification', 'complete']);
  assert.equal((await readAgentCommandSubmission(first.executionId))?.verdict, 'failed');

  const second = await begin(delegation, `${taskId}-cycle-two`);
  const restored = await command(second.executionId, second.token!, ['verification', 'status']);
  assert.match(restored, /验证草稿 v2/);
  assert.match(restored, /阶段：逐项执行测试/);
  assert.match(restored, /计划场景：1/);
  assert.match(restored, /执行结果：0\/1/);
  await assert.rejects(
    command(second.executionId, second.token!, ['verification', 'complete']),
    /result-page/,
  );
});

test('a changed delivery contract reopens a waiting frozen plan without losing the runtime answer', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    saveDeliverySpec,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('规格变化后重新规划验证');
  const first = await begin(delegation, `${taskId}-spec-change-input`);
  await command(first.executionId, first.token!, ['verification', 'status']);
  await upsertFrontendPlan(first.executionId, first.token!);
  await command(first.executionId, first.token!, ['verification', 'plan', 'freeze']);
  await command(first.executionId, first.token!, [
    'verification', 'request-input',
    '--key', 'preview-url',
    '--title', '前端预览地址',
    '--question', '应使用哪个非敏感预览地址？',
    '--why', '需要执行真实前端闭环',
  ]);
  const pending = await readAgentCommandSubmission(first.executionId);
  await applyAgentResult(`RUN-verification-spec-change-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);
  const request = (await getTask(taskId))?.runtimeInputs.find((item) =>
    item.request_key === 'preview-url');
  assert.ok(request);
  await answerRuntimeInput({
    taskId,
    requestId: request!.request_id,
    answer: '使用 http://localhost:3002。',
  });
  await submitRuntimeInputs(taskId);
  await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: deliverySpecFixture({
      summary: '交付契约修订后仍要求从前端独立验证结果状态。',
      handoff: {
        implementationGuidance: '复用现有结果状态组件。',
        guardrails: [{
          key: 'pending-visible',
          content: '未完成状态仍需保持可见',
          rationale: '不能因完成态改动破坏相邻业务状态',
        }],
        verificationFocus: [{
          key: 'AC-status',
          expected: '结果完成后页面展示清晰的完成状态',
          oracle: '页面存在可识别且无歧义的完成状态',
        }],
      },
    }),
  });
  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'test-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-spec-change-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['verification', 'status']);
  assert.match(restored, /验证草稿 v2/);
  assert.match(restored, /阶段：规划测试计划/);
  assert.match(restored, /计划绑定 未冻结/);
  assert.match(restored, /执行结果：0\/1/);
  assert.match(restored, /preview-url.*已回答=使用 http:\/\/localhost:3002/);
});

test('legacy verification result-filling commands are not accepted', async () => {
  const { taskId, delegation } = await verificationDelegation('旧验证命令彻底移除');
  const started = await begin(delegation, `${taskId}-legacy`);
  await command(started.executionId, started.token!, ['verification', 'status']);
  for (const args of [
    ['verification', 'summary', 'set', '--text', '旧摘要'],
    ['verification', 'criterion', 'upsert', '--key', 'unit-acceptance'],
    ['verification', 'check', 'upsert', '--key', 'legacy'],
    ['verification', 'failure', 'set', '--kind', 'implementation'],
    ['verification', 'recovery', 'upsert', '--id', 'REC-1'],
    ['verification', 'risk', 'record', '--key', 'legacy', '--content', '旧风险'],
    ['verification', 'runtime-input', 'request', '--key', 'legacy'],
    ['verification', 'pass'],
    ['verification', 'fail'],
    ['verification', 'block'],
  ]) {
    await assert.rejects(command(started.executionId, started.token!, args), /未知命令/);
  }
});
