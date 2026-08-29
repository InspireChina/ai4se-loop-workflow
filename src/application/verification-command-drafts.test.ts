import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function resolveVerificationAssistance(answer: string) {
  const {
    claimNextVerificationAssistance,
    completeVerificationAssistanceExecution,
    runVerificationAssistanceCommand,
  } = await import('./verification-assistance');
  const claimed = await claimNextVerificationAssistance({
    runId: `RUN-system-assistance-${Date.now()}-${Math.random()}`,
    executorId: 'codex',
    executionOptions: {},
  });
  assert.ok(claimed);
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId, sessionId: claimed.sessionId, token: claimed.token,
    args: ['verification-assistance', 'status'],
  });
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId, sessionId: claimed.sessionId, token: claimed.token,
    args: ['verification-assistance', 'resolve', '--answer', answer],
  });
  await completeVerificationAssistanceExecution(claimed.executionId);
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-verification-chain-${suffix}`,
    delegation,
    prompt: `YAML independent verification ${suffix}`,
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function verificationDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, saveDeliverySpec } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();
  const taskId = await createTask({ title, description: '用户需要验证结果页完成状态。' });
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'in dev', current_subagent = 'test-agent',
          total_stories = 1, analysis_index = 1, spec_resolved_index = 1,
          dev_index = 1, test_index = 0, next_step = '验证结果页完成状态'
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
          key: 'pending-visible', content: '未完成状态仍需保持可见',
          rationale: '不能因完成态改动破坏相邻业务状态',
        }],
        verificationFocus: [{
          key: 'AC-status', expected: '结果完成后页面展示完成状态',
          oracle: '页面存在可识别的完成状态',
        }],
      },
    }),
  });
  const delegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.agent === 'test-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function put(
  executionId: string,
  token: string,
  block: string,
  content: string,
  key?: string,
) {
  return command(executionId, token, [
    'artifact', 'put', '--artifact', 'verification', '--block', block,
    ...(key ? ['--key', key] : []), '--content', content,
  ]);
}

async function putScenario(executionId: string, token: string, key = 'result-page') {
  return put(executionId, token, 'scenarios', [
    'channel: frontend',
    'title: 用户从结果页观察完成与未完成状态',
    'setup: 应用已启动，存在一条完成结果和一条未完成结果',
    'steps: 打开 /results，并分别查看两条结果',
    'expected: 完成结果展示完成状态，未完成结果仍保持可识别',
    'coverageRefs: [unit-acceptance, focus:AC-status, guardrail:pending-visible]',
  ].join('\n'), key);
}

async function putResult(
  executionId: string,
  token: string,
  input: {
    key?: string;
    status: 'passed' | 'failed' | 'blocked';
    failureKind?: 'implementation' | 'specification' | 'environment' | 'inconclusive';
    evidence: string;
    actualBehavior?: string;
  },
) {
  return put(executionId, token, 'results', [
    `status: ${input.status}`,
    ...(input.failureKind ? [`failureKind: ${input.failureKind}`] : []),
    `evidence: ${input.evidence}`,
    ...(input.actualBehavior ? [`actualBehavior: ${input.actualBehavior}`] : []),
  ].join('\n'), input.key || 'result-page');
}

async function reachExecute(executionId: string, token: string) {
  await command(executionId, token, ['phase', 'complete']);
  await putScenario(executionId, token);
  return command(executionId, token, ['phase', 'complete']);
}

async function finish(executionId: string, token: string, risk?: string) {
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'evidence-review', [
    'summary: 逐项复核 Expected、Actual、独立证据和责任分类，证据足以支持当前结论。',
    ...(risk ? [`residualRisk: ${risk}`] : []),
  ].join('\n'));
  await command(executionId, token, ['phase', 'complete']);
  return command(executionId, token, ['phase', 'complete']);
}

test('Test Agent uses only the YAML command chain and compiles a passing independent verification result', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation } = await verificationDelegation('YAML 独立验证通过');
  const active = await begin(delegation, `${taskId}-pass`);

  assert.match(await command(active.executionId, active.token!, ['help']), /通用命令链/);
  await assert.rejects(command(active.executionId, active.token!, ['verification', 'status']), /当前草稿使用通用命令链/);
  const status = await command(active.executionId, active.token!, ['status']);
  assert.match(status, /Phase: inputs/);
  assert.match(status, /unit-acceptance.*missing/s);
  assert.match(status, /focus:AC-status/);
  assert.match(status, /guardrail:pending-visible/);
  assert.match(await reachExecute(active.executionId, active.token!), /EXECUTE · builtin/);
  await assert.rejects(putScenario(active.executionId, active.token!), /验证计划已经冻结/);
  await putResult(active.executionId, active.token!, {
    status: 'passed', evidence: '浏览器截图明确显示完成和未完成两种状态',
    actualBehavior: '完成结果展示完成状态，未完成结果保持可识别',
  });
  assert.match(await finish(active.executionId, active.token!, '不代表全站视觉回归'), /Outcome: completed/);

  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.verdict, 'passed');
  assert.match(result?.artifact?.content || '', /unit-acceptance/);
  assert.match(result?.artifact?.content || '', /不代表全站视觉回归/);
  await applyAgentResult(`RUN-verification-pass-${taskId}`, delegation, result!, { executionId: active.executionId });
  await completeExecution(active.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.test_index, 1);
  assert.equal(detail?.task.current_subagent, 'review-agent');

  const db = await databaseConnection();
  assert.deepEqual(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('verification_drafts', 'verification_plan_scenarios', 'verification_results')
  `).all(), []);
});

test('Test final gate derives specification and implementation rewinds from failed Artifact results', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await verificationDelegation('YAML 验证失败归因');
  const active = await begin(delegation, `${taskId}-failure`);
  await command(active.executionId, active.token!, ['status']);
  await reachExecute(active.executionId, active.token!);
  await assert.rejects(putResult(active.executionId, active.token!, {
    status: 'failed', failureKind: 'environment', evidence: '错误分类',
  }).then(() => command(active.executionId, active.token!, ['phase', 'complete'])), /implementation 或 specification/);
  await putResult(active.executionId, active.token!, {
    status: 'failed', failureKind: 'specification', evidence: '冻结 Oracle 与两个既有业务状态相互冲突',
    actualBehavior: '无法同时满足完成态和保护项',
  });
  await finish(active.executionId, active.token!);
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.verdict, 'failed');
  assert.equal(result?.failureKind, 'specification');
  assert.equal(result?.rewindTo, 'analysis');
  assert.equal(result?.rewindDeliveryUnit, 1);
});

test('blocked verification pauses through generic runtime input and resumes the same frozen scenario', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { getTask } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('YAML 验证运行信息恢复');
  const first = await begin(delegation, `${taskId}-input`);
  await command(first.executionId, first.token!, ['status']);
  await reachExecute(first.executionId, first.token!);
  await putResult(first.executionId, first.token!, {
    status: 'blocked', failureKind: 'environment',
    evidence: '浏览器无法连接预览环境', actualBehavior: '缺少可访问的前端地址',
  });
  await command(first.executionId, first.token!, [
    'runtime-input', 'put', '--key', 'preview-url', '--title', '前端预览地址',
    '--question', '应使用哪个已部署的非敏感前端预览地址？',
    '--why', '需要从真实前端入口完成黑盒测试', '--recommendation', '提供当前测试环境的预览 URL',
  ]);
  assert.match(await command(first.executionId, first.token!, ['phase', 'complete']), /waiting_for_human/);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.runtimeInputs[0]?.key, 'preview-url');
  await applyAgentResult(`RUN-verification-input-${taskId}`, delegation, pending!, { executionId: first.executionId });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) => item.request_key === 'preview-url');
  assert.ok(request);
  await resolveVerificationAssistance('使用 http://localhost:3001。');
  const resumedDelegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.agent === 'test-agent' && item.pipeline === 'resume') as DelegationEnvelope;
  assert.ok(resumedDelegation);
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['status']);
  assert.match(restored, /Phase: execute/);
  assert.match(restored, /preview-url.*answered/s);
  await putResult(resumed.executionId, resumed.token!, {
    status: 'passed', evidence: '在用户提供的预览地址完成前端黑盒验证',
    actualBehavior: '页面结果符合冻结 Oracle',
  });
  await finish(resumed.executionId, resumed.token!);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completed?.verdict, 'passed');
  await applyAgentResult(`RUN-verification-resume-${taskId}`, resumedDelegation, completed!, { executionId: resumed.executionId });
  await completeExecution(resumed.executionId);
  detail = await getTask(taskId);
  assert.equal(detail?.runtimeInputs.find((item) => item.request_key === 'preview-url')?.status, 'resolved');
});

test('a new verification cycle reuses a matching frozen plan but resets when the Delivery Spec changes', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { saveDeliverySpec } = await import('./tasks');
  const { taskId, delegation } = await verificationDelegation('YAML 验证计划跨轮复用');
  const first = await begin(delegation, `${taskId}-cycle-one`);
  await command(first.executionId, first.token!, ['status']);
  await reachExecute(first.executionId, first.token!);
  await putResult(first.executionId, first.token!, {
    status: 'failed', failureKind: 'implementation', evidence: '页面仍显示旧状态',
  });
  await finish(first.executionId, first.token!);
  assert.equal((await readAgentCommandSubmission(first.executionId))?.verdict, 'failed');

  const second = await begin(delegation, `${taskId}-cycle-two`);
  const reused = await command(second.executionId, second.token!, ['status']);
  assert.match(reused, /Phase: execute/);
  assert.match(reused, /verification\.scenarios\.result-page/);
  assert.doesNotMatch(reused, /verification\.results\.result-page/);
  await putResult(second.executionId, second.token!, {
    status: 'passed', evidence: '修正后页面状态符合当前冻结 Oracle',
  });
  await finish(second.executionId, second.token!);

  await saveDeliverySpec({
    taskId, storyIndex: 1, status: 'resolved',
    spec: deliverySpecFixture({
      summary: '修订后的交付契约增加更明确的结果状态 Oracle。',
      handoff: {
        implementationGuidance: '保持业务语义。', guardrails: [],
        verificationFocus: [{ key: 'new-status', expected: '完成状态包含完成时间', oracle: '页面显示完成时间' }],
      },
    }),
  });
  const third = await begin(delegation, `${taskId}-cycle-three`);
  const reset = await command(third.executionId, third.token!, ['status']);
  assert.match(reset, /Phase: inputs/);
  assert.match(reset, /focus:new-status/);
  assert.doesNotMatch(reset, /verification\.scenarios\.result-page/);
});
