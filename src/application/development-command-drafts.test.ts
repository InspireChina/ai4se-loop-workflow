import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { developmentHelp } from './development-command-drafts';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function ensureRepository() {
  const { paths } = await import('../infrastructure/database');
  try {
    git(['rev-parse', '--is-inside-work-tree'], paths.root);
  } catch {
    git(['init'], paths.root);
    git(['config', 'user.email', 'loopwork-test@example.com'], paths.root);
    git(['config', 'user.name', 'LoopWork Test'], paths.root);
    writeFileSync(join(paths.root, 'fixture.txt'), 'baseline\n', 'utf8');
    git(['add', 'fixture.txt'], paths.root);
    git(['commit', '-m', 'test baseline'], paths.root);
  }
  return paths.root;
}

async function begin(
  delegation: DelegationEnvelope,
  suffix: string,
  prompt = 'progressive development prompt',
) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const { gitHead } = await import('../infrastructure/git');
  const root = await ensureRepository();
  const started = await beginExecutionAttempt({
    runId: `RUN-development-${suffix}`,
    delegation,
    prompt,
    baseCommit: gitHead(root),
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function developmentDelegation(title: string) {
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
  await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: deliverySpecFixture({
      handoff: {
        implementationGuidance: '复用现有结果状态组件。',
        guardrails: [],
        verificationFocus: [{
          key: 'AC-status',
          expected: '结果完成后页面展示完成状态',
          oracle: '页面存在可识别的完成状态',
        }],
      },
    }),
  });
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'dev-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordCapturedCommand(executionId: string, actualCommand: string, passed = true) {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const current = db.prepare(`
    SELECT COALESCE(MAX(CAST(receipt_key AS INTEGER)), 0) AS sequence
    FROM execution_receipts
    WHERE execution_id = ? AND kind = 'tool_event'
  `).get(executionId) as { sequence: number };
  const started = current.sequence + 1;
  const completed = started + 1;
  const receiptKey = String(completed).padStart(8, '0');
  const toolCallId = `tool-${completed}`;
  const commandHash = createHash('sha256').update(actualCommand).digest('hex');
  const insert = db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, 'tool_event', ?, ?)
  `);
  insert.run(randomUUID(), executionId, String(started).padStart(8, '0'), JSON.stringify({
    name: 'loop.agent.tool',
    executor: 'codex',
    phase: 'started',
    tool: 'shell',
    toolClass: 'shell',
    toolCallId,
    sequence: started,
    input: actualCommand,
    commandHash,
    originalLength: actualCommand.length,
  }));
  insert.run(randomUUID(), executionId, receiptKey, JSON.stringify({
    name: 'loop.agent.tool',
    executor: 'codex',
    phase: 'completed',
    tool: 'shell',
    toolClass: 'shell',
    toolCallId,
    sequence: completed,
    summary: passed ? '检查通过' : '检查失败',
    level: passed ? 'DEFAULT' : 'ERROR',
    success: passed,
    exitCode: passed ? 0 : 1,
    input: actualCommand,
    commandHash,
    originalLength: actualCommand.length,
  }));
  return receiptKey;
}

async function recordImplementationEvidence(executionId: string, token: string) {
  await command(executionId, token, [
    'implementation', 'criterion', 'satisfy', '--key', 'AC-status',
    '--evidence', '结果状态组件覆盖完成结果分支。',
  ]);
  await command(executionId, token, [
    'implementation', 'criterion', 'satisfy', '--key', 'unit-acceptance',
    '--evidence', '结果页从触发到完成状态形成可观察闭环。',
  ]);
}

async function passCodeReview(executionId: string, token: string) {
  await command(executionId, token, ['implementation', 'implement', 'complete']);
  await command(executionId, token, [
    'implementation', 'review', 'record', '--result', 'pass',
    '--summary', '实现符合现有组件边界、命名规则和错误处理惯例，没有重复或不必要复杂度。',
    '--evidence', '走查结果状态组件、相邻组件模式和当前 diff。',
  ]);
  await command(executionId, token, ['implementation', 'review', 'complete']);
}

async function recordDeveloperCheck(executionId: string, token: string) {
  const receipt = await recordCapturedCommand(executionId, 'npm test -- result-status');
  await command(executionId, token, [
    'implementation', 'check', 'record', '--key', 'status-component',
    '--receipt', receipt,
    '--summary', '完成状态分支回归通过。',
  ]);
}

async function recordCompletedImplementation(executionId: string, token: string) {
  await recordImplementationEvidence(executionId, token);
  await passCodeReview(executionId, token);
  await recordDeveloperCheck(executionId, token);
  await command(executionId, token, ['implementation', 'verify', 'complete']);
  await command(executionId, token, ['implementation', 'commit', 'complete']);
  await command(executionId, token, ['implementation', 'validate']);
}

test('development help exposes judgments and a trusted commit confirmation phase', () => {
  const terminalActions = [
    'implementation complete',
    'implementation request-input',
    'implementation fail',
  ];
  const help = developmentHelp(terminalActions).join('\n');
  assert.match(help, /help evidence/);
  assert.match(help, /Application 记录 Runner 命令事实/);
  assert.match(help, /IMPLEMENT → REVIEW → DEVELOPER VERIFY → COMMIT → FINALIZE/);
  assert.match(help, /implementation review complete/);
  assert.match(help, /implementation commit complete/);
  assert.match(help, /修正、风险、恢复和运行信息属于按需路径/);
  assert.doesNotMatch(help, /handoff|开发交接|开发与验证交接/);
  assert.doesNotMatch(
    help,
    /implementation (?:criterion reopen|check discard|risk record|runtime-input request|recovery resolve)/,
  );
  assert.doesNotMatch(help, /assessment set|change upsert|commit set|test upsert|failure set/);
  assert.doesNotMatch(help, /delivery-analysis impact|verification pass/);

  const evidence = developmentHelp(terminalActions, 'evidence').join('\n');
  assert.match(evidence, /选择明确成功的 receipt/);
  assert.match(evidence, /绑定该 receipt 的原始命令哈希/);
  assert.match(evidence, /Git 历史、分支、HEAD 和未提交文件不使检查失效/);
  assert.match(evidence, /不要手抄 command、passed 或 exit code/);
  assert.match(evidence, /复用系统给出的 RECOVERY id/);

  const input = developmentHelp(terminalActions, 'input').join('\n');
  assert.match(input, /implementation fail --reason/);
  assert.match(input, /不需要预先维护 failure 字段/);

  const review = developmentHelp(terminalActions, 'review').join('\n');
  assert.match(review, /代码质量门禁/);
  assert.match(review, /needs_changes/);
  assert.match(review, /回流会清除旧审查结论/);

  const commit = developmentHelp(terminalActions, 'commit').join('\n');
  assert.match(commit, /implementation commit complete/);
  assert.match(commit, /不制造空提交/);
  assert.match(commit, /不读取或校验 commit hash、HEAD、提交内容、暂存区、工作区状态/);

  const finish = developmentHelp(terminalActions, 'finish').join('\n');
  assert.match(finish, /基于当前仓库重新检查功能完整性/);
  assert.match(finish, /COMMIT 阶段已经由 Agent 显式确认/);
  assert.match(finish, /不校验 Git 历史、分支、HEAD、commit hash、提交内容或工作区状态/);

  assert.throws(
    () => developmentHelp(terminalActions, 'unknown'),
    /可用主题：context、evidence、review、commit、input、finish/,
  );
});

test('development agent confirms the commit phase without Application Git validation', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineForTask } = await import('./tasks');
  const { taskId, delegation } = await developmentDelegation('精简后的开发走查');
  const started = await begin(delegation, `${taskId}-existing`);

  await assert.rejects(
    command(started.executionId, started.token!, ['help']),
    /必须指定一个主题/,
  );
  assert.match(
    await command(started.executionId, started.token!, ['help', 'evidence']),
    /帮助主题：evidence/,
  );
  await assert.rejects(
    command(started.executionId, started.token!, [
      'implementation', 'criterion', 'satisfy', '--key', 'AC-status',
      '--evidence', '不能跳过 status',
    ]),
    /implementation status/,
  );
  const initial = await command(started.executionId, started.token!, ['implementation', 'status']);
  assert.match(initial, /Phase: implement/);
  assert.match(initial, /IMPLEMENT · implement/);
  assert.match(initial, /开发实现草稿 v1/);
  assert.match(initial, /仓库观察（仅供调查，不参与完成校验）/);
  assert.match(initial, /unit-acceptance.*尚未证明/);
  assert.match(initial, /AC-status.*尚未证明/);
  await assert.rejects(
    command(started.executionId, started.token!, [
      'implementation', 'criterion', 'satisfy',
      '--key', 'ac-description-label',
      '--evidence', '自由文本中的标签不能成为规格 key。',
    ]),
    /验收标准 key ac-description-label 不属于当前冻结交付规格。允许使用的 key：unit-acceptance, AC-status/,
  );
  const db = await databaseConnection();
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM development_criteria
      WHERE criterion_key = 'ac-description-label'
    `).get() as { count: number }).count,
    0,
  );
  await assert.rejects(
    command(started.executionId, started.token!, [
      'implementation', 'handoff', 'set', '--text', '该命令已经删除',
    ]),
    /未知命令：implementation handoff set/,
  );
  await recordImplementationEvidence(started.executionId, started.token!);
  const reviewPacket = await command(
    started.executionId,
    started.token!,
    ['implementation', 'implement', 'complete'],
  );
  assert.match(reviewPacket, /REVIEW · review/);
  await command(started.executionId, started.token!, [
    'implementation', 'review', 'record', '--result', 'needs_changes',
    '--summary', '发现结果状态分支存在重复条件，需要先收敛。',
    '--evidence', '结果状态组件当前 diff 中的重复分支。',
  ]);
  await assert.rejects(
    command(started.executionId, started.token!, ['implementation', 'review', 'complete']),
    /必须回流 IMPLEMENT/,
  );
  const reopened = await command(started.executionId, started.token!, [
    'implementation', 'review', 'reopen-implementation',
    '--reason', '消除重复条件并按仓库模式收敛状态分支',
  ]);
  assert.match(reopened, /From: review[\s\S]*To: implement/);
  await command(started.executionId, started.token!, ['implementation', 'implement', 'complete']);
  await command(started.executionId, started.token!, [
    'implementation', 'review', 'record', '--result', 'pass',
    '--summary', '现有实现符合组件边界和仓库代码规范。',
    '--evidence', '结果状态组件、相邻组件模式与当前 diff。',
  ]);
  const verifyPacket = await command(
    started.executionId,
    started.token!,
    ['implementation', 'review', 'complete'],
  );
  assert.match(verifyPacket, /DEVELOPER VERIFY/);
  const failedReceipt = await recordCapturedCommand(
    started.executionId,
    'npm test -- result-status',
    false,
  );
  await assert.rejects(
    command(started.executionId, started.token!, [
      'implementation', 'check', 'record', '--key', 'failed-check',
      '--receipt', failedReceipt,
      '--summary', '不能把失败命令声明为通过。',
    ]),
    /所选命令没有明确成功/,
  );
  await recordDeveloperCheck(started.executionId, started.token!);
  await recordCapturedCommand(started.executionId, 'npm test -- result-status', false);
  await assert.rejects(
    command(started.executionId, started.token!, ['implementation', 'verify', 'complete']),
    /关键检查之后又执行了同一命令/,
  );
  const recoveredReceipt = await recordCapturedCommand(
    started.executionId,
    'npm test -- result-status',
  );
  await command(started.executionId, started.token!, [
    'implementation', 'check', 'record', '--key', 'status-component',
    '--receipt', recoveredReceipt,
    '--summary', '失败修复后重新执行完成状态分支回归并通过。',
  ]);
  const commitPacket = await command(
    started.executionId,
    started.token!,
    ['implementation', 'verify', 'complete'],
  );
  assert.match(commitPacket, /COMMIT · commit/);
  assert.match(commitPacket, /Application 将信任本次确认/);
  await assert.rejects(
    command(started.executionId, started.token!, ['implementation', 'complete']),
    /complete 只能在 finalize 阶段执行；当前阶段是 commit/,
  );
  const finalizePacket = await command(
    started.executionId,
    started.token!,
    ['implementation', 'commit', 'complete'],
  );
  assert.match(finalizePacket, /From: commit[\s\S]*To: finalize/);
  await assert.rejects(
    command(started.executionId, started.token!, ['implementation', 'complete']),
    /尚未通过 validate/,
  );
  assert.match(
    await command(started.executionId, started.token!, ['implementation', 'validate']),
    /Outcome: validation_passed[\s\S]*Action: `implementation complete`/,
  );
  await command(started.executionId, started.token!, ['implementation', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.changedFiles, undefined);
  assert.equal(result?.tests?.[0]?.passed, true);
  assert.equal(result?.tests?.[0]?.command, 'npm test -- result-status');
  assert.match(
    result?.summary || '',
    /^开发实现完成：2\/2 项验收语义已有实现证据，1 项开发检查通过。$/,
  );
  assert.doesNotMatch(result?.artifact?.content || '', /仓库事实|Git 基线|Commit/);
  assert.doesNotMatch(result?.artifact?.content || '', /开发与验证交接|开发交接/);
  assert.doesNotMatch(result?.artifact?.content || '', /AC-status|unit-acceptance|status-component/);
  assert.match(result?.artifact?.content || '', /## 代码审查[\s\S]*结论：通过/);

  const transitions = db.prepare(`
    SELECT from_phase, to_phase
    FROM development_phase_transitions transition_record
    JOIN agent_work_drafts draft ON draft.draft_id = transition_record.draft_id
    WHERE draft.task_id = ? AND draft.story_index = 1
    ORDER BY transition_id
  `).all(taskId) as { from_phase: string; to_phase: string }[];
  assert.deepEqual(transitions.map((item) => [item.from_phase, item.to_phase]), [
    ['implement', 'review'],
    ['review', 'implement'],
    ['implement', 'review'],
    ['review', 'developer_verify'],
    ['developer_verify', 'commit'],
    ['commit', 'finalize'],
  ]);

  await applyAgentResult(`RUN-development-existing-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'test-agent');
});

test('development runtime input keeps a stable request key and answer across resume', async () => {
  const { paths } = await import('../infrastructure/database');
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
  appendFileSync(join(paths.root, 'fixture.txt'), `implemented before runtime input ${taskId}\n`, 'utf8');
  git(['add', 'fixture.txt'], paths.root);
  git(['commit', '-m', 'implement before requesting runtime input'], paths.root);
  await command(first.executionId, first.token!, [
    'implementation', 'runtime-input', 'request', '--key', 'preview-url',
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
      'implementation', 'runtime-input', 'withdraw', '--key', 'preview-url',
    ]),
    /必须保留原 request key/,
  );
  await recordCompletedImplementation(resumed.executionId, resumed.token!);
  await command(resumed.executionId, resumed.token!, ['implementation', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completed?.changedFiles, undefined);
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

test('development recovery cycle requires every active recovery and a check from the current execution', async () => {
  const { createOrReopenRecoveryItem } = await import('./recovery-items');
  const { cancelExecution, completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await developmentDelegation('开发恢复修正闭环');

  const original = await begin(
    delegation,
    `${taskId}-before-recovery`,
    'development before recovery',
  );
  await command(original.executionId, original.token!, ['implementation', 'status']);
  await recordCompletedImplementation(original.executionId, original.token!);
  await command(original.executionId, original.token!, ['implementation', 'complete']);
  await completeExecution(original.executionId);

  const recovery = await createOrReopenRecoveryItem({
    taskId,
    storyIndex: 1,
    kind: 'test_failure',
    sourceAgent: 'test-agent',
    targetStage: 'dev',
    summary: '完成状态在刷新后消失，需要修正并重新验证。',
    details: { failedCheck: 'refresh-result-status' },
    sourceExecutionId: `EXEC-test-${taskId}`,
  });
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const analysisRecoveryId = `REC-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO recovery_items(
      recovery_id, task_id, story_index, kind, source_agent, target_stage,
      status, summary, details_json, source_execution_id
    ) VALUES(?, ?, 1, 'test_failure', 'test-agent', 'analysis',
      'pending', ?, ?, ?)
  `).run(
    analysisRecoveryId,
    taskId,
    '既有方案遗漏刷新后的状态来源，需要一并落实分析修正。',
    JSON.stringify({ failedCheck: 'refresh-state-source' }),
    `EXEC-test-analysis-${taskId}`,
  );

  const correction = await begin(
    delegation,
    `${taskId}-recovery`,
    'development recovery correction',
  );
  const correctionStatus = await command(
    correction.executionId,
    correction.token!,
    ['implementation', 'status'],
  );
  assert.match(correctionStatus, new RegExp(recovery.recovery_id));
  assert.match(correctionStatus, new RegExp(analysisRecoveryId));
  assert.match(correctionStatus, /活动恢复事项：2（已声明处理 0）/);
  assert.match(correctionStatus, /关键检查：0（本次 execution；草稿共 0）/);
  assert.doesNotMatch(correctionStatus, /交接结论|开发交接/);
  assert.match(correctionStatus, /AC-status：.*已证明/);
  await assert.rejects(
    command(correction.executionId, correction.token!, ['implementation', 'implement', 'complete']),
    new RegExp(recovery.recovery_id),
  );
  await assert.rejects(
    command(correction.executionId, correction.token!, ['implementation', 'implement', 'complete']),
    new RegExp(analysisRecoveryId),
  );
  await assert.rejects(
    command(correction.executionId, correction.token!, [
      'implementation', 'recovery', 'resolve',
      '--id', 'REC-not-active',
      '--summary', '错误引用',
      '--evidence', '无',
    ]),
    /不是当前交付单元的活动恢复事项/,
  );
  await command(correction.executionId, correction.token!, [
    'implementation', 'recovery', 'resolve',
    '--id', recovery.recovery_id,
    '--summary', '已修正刷新后的状态恢复路径。',
    '--evidence', '结果状态恢复用例已覆盖刷新场景。',
  ]);
  await assert.rejects(
    command(correction.executionId, correction.token!, ['implementation', 'implement', 'complete']),
    new RegExp(`活动恢复事项尚未声明处理：${analysisRecoveryId}`),
  );
  await command(correction.executionId, correction.token!, [
    'implementation', 'recovery', 'resolve',
    '--id', analysisRecoveryId,
    '--summary', '已同步落实刷新状态来源的分析修正。',
    '--evidence', '实现与修订后的状态来源保持一致。',
  ]);
  await command(correction.executionId, correction.token!, ['implementation', 'implement', 'complete']);
  await command(correction.executionId, correction.token!, [
    'implementation', 'review', 'record', '--result', 'pass',
    '--summary', '恢复修正符合状态组件边界、仓库规范和 Clean Code 原则。',
    '--evidence', '刷新恢复路径 diff、结果状态组件及相邻模式。',
  ]);
  await command(correction.executionId, correction.token!, ['implementation', 'review', 'complete']);
  const correctionReceipt = await recordCapturedCommand(
    correction.executionId,
    'npm test -- refresh-result-status',
  );
  await command(correction.executionId, correction.token!, [
    'implementation', 'check', 'record', '--key', 'recovery-refresh',
    '--receipt', correctionReceipt,
    '--summary', '刷新后的完成状态回归通过。',
  ]);
  await command(correction.executionId, correction.token!, ['implementation', 'verify', 'complete']);
  await command(correction.executionId, correction.token!, ['implementation', 'commit', 'complete']);
  await command(correction.executionId, correction.token!, ['implementation', 'validate']);

  await cancelExecution(correction.executionId, 'simulate interrupted correction execution');
  const resumed = await begin(
    delegation,
    `${taskId}-recovery-resume`,
    'development recovery correction resumed',
  );
  const resumedStatus = await command(
    resumed.executionId,
    resumed.token!,
    ['implementation', 'status'],
  );
  assert.match(resumedStatus, /活动恢复事项：2（已声明处理 2）/);
  assert.match(resumedStatus, /关键检查：0（本次 execution；草稿共 1）/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['implementation', 'complete']),
    /本次 execution 重新执行并记录一条真实成功检查/,
  );
  await command(resumed.executionId, resumed.token!, [
    'implementation', 'finalize', 'reopen-verification',
    '--reason', '恢复执行必须重新绑定当前 execution 的检查结果',
  ]);
  const resumedReceipt = await recordCapturedCommand(
    resumed.executionId,
    'npm test -- refresh-result-status',
  );
  await command(resumed.executionId, resumed.token!, [
    'implementation', 'check', 'record', '--key', 'recovery-refresh',
    '--receipt', resumedReceipt,
    '--summary', '恢复执行后重新运行刷新状态回归并通过。',
  ]);
  await command(resumed.executionId, resumed.token!, ['implementation', 'verify', 'complete']);
  await command(resumed.executionId, resumed.token!, ['implementation', 'commit', 'complete']);
  await command(resumed.executionId, resumed.token!, ['implementation', 'validate']);
  await command(resumed.executionId, resumed.token!, ['implementation', 'complete']);
  const result = await readAgentCommandSubmission(resumed.executionId);
  assert.deepEqual(result?.recoveryResolutions, [{
    recoveryId: recovery.recovery_id,
    summary: '已修正刷新后的状态恢复路径。',
    evidence: ['结果状态恢复用例已覆盖刷新场景。'],
  }, {
    recoveryId: analysisRecoveryId,
    summary: '已同步落实刷新状态来源的分析修正。',
    evidence: ['实现与修订后的状态来源保持一致。'],
  }]);
  assert.deepEqual(result?.tests, [{
    command: 'npm test -- refresh-result-status',
    passed: true,
    summary: '恢复执行后重新运行刷新状态回归并通过。',
  }]);
  assert.doesNotMatch(result?.artifact?.content || '', new RegExp(`${recovery.recovery_id}|${analysisRecoveryId}`));
  await completeExecution(resumed.executionId);
});

test('development completion ignores unrelated uncommitted files even when they change', async () => {
  const { paths } = await import('../infrastructure/database');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { taskId, delegation } = await developmentDelegation('保留已有无关工作区改动');
  const dirtyPath = join(paths.root, `preexisting-${taskId}.txt`);
  writeFileSync(dirtyPath, 'pre-existing unrelated work\n', 'utf8');
  try {
    const started = await begin(delegation, `${taskId}-preserved-dirty`);
    const status = await command(started.executionId, started.token!, ['implementation', 'status']);
    assert.match(status, /当前未提交项：1/);
    await recordCompletedImplementation(started.executionId, started.token!);
    writeFileSync(dirtyPath, 'human documentation changed while Dev was running\n', 'utf8');
    await command(started.executionId, started.token!, ['implementation', 'complete']);
    const result = await readAgentCommandSubmission(started.executionId);
    assert.equal(result?.changedFiles, undefined);
    await completeExecution(started.executionId);
  } finally {
    rmSync(dirtyPath, { force: true });
  }
});

test('development completion does not freeze files created before the first status read', async () => {
  const { paths } = await import('../infrastructure/database');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await developmentDelegation('未提交代码事实校验');
  const started = await begin(delegation, `${taskId}-dirty`);
  const dirtyPath = join(paths.root, 'uncommitted-change.txt');
  writeFileSync(dirtyPath, 'not committed\n', 'utf8');
  try {
    const status = await command(started.executionId, started.token!, ['implementation', 'status']);
    assert.match(status, /当前未提交项：1/);
    await recordCompletedImplementation(started.executionId, started.token!);
    await command(started.executionId, started.token!, ['implementation', 'complete']);
    const result = await readAgentCommandSubmission(started.executionId);
    assert.equal(result?.changedFiles, undefined);
    await completeExecution(started.executionId);
  } finally {
    rmSync(dirtyPath, { force: true });
  }
});

test('development completion does not attribute other commits to the execution', async () => {
  const { paths } = await import('../infrastructure/database');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { taskId, delegation } = await developmentDelegation('自动隔离已有无关改动');
  const relativePreexisting = `preexisting-${taskId}.txt`;
  const preexistingPath = join(paths.root, relativePreexisting);
  writeFileSync(preexistingPath, 'pre-existing unrelated work\n', 'utf8');
  try {
    const started = await begin(delegation, `${taskId}-materialized-baseline`);
    await command(started.executionId, started.token!, ['implementation', 'status']);
    git(['add', relativePreexisting], paths.root);
    git(['commit', '-m', 'preserve pre-existing workspace changes'], paths.root);
    appendFileSync(join(paths.root, 'fixture.txt'), `implementation ${taskId}\n`, 'utf8');
    git(['add', 'fixture.txt'], paths.root);
    git(['commit', '-m', 'implement isolated delivery change'], paths.root);
    await recordCompletedImplementation(started.executionId, started.token!);
    await command(started.executionId, started.token!, ['implementation', 'complete']);
    const result = await readAgentCommandSubmission(started.executionId);
    assert.equal(result?.changedFiles, undefined);
    assert.doesNotMatch(result?.artifact?.content || '', /仓库事实|推进到 Commit/);
    await completeExecution(started.executionId);
  } finally {
    git(['rm', '-f', '--ignore-unmatch', relativePreexisting], paths.root);
    rmSync(preexistingPath, { force: true });
    if (git(['status', '--porcelain', '--', relativePreexisting], paths.root)) {
      git(['commit', '-m', 'clean up pre-existing fixture'], paths.root);
    }
  }
});

test('development completion does not block when Git history changes after a successful check', async () => {
  const { paths } = await import('../infrastructure/database');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { taskId, delegation } = await developmentDelegation('Git 历史不形成完成门禁');
  const started = await begin(delegation, `${taskId}-changed`);
  const originalHead = git(['rev-parse', 'HEAD'], paths.root);
  await command(started.executionId, started.token!, ['implementation', 'status']);
  await recordCompletedImplementation(started.executionId, started.token!);
  try {
    const tree = git(['write-tree'], paths.root);
    const unrelatedHead = git(
      ['commit-tree', tree, '-m', 'unrelated history for completion gate test'],
      paths.root,
    );
    git(['reset', '--hard', unrelatedHead], paths.root);
    const status = await command(started.executionId, started.token!, ['implementation', 'status']);
    assert.match(status, new RegExp(`当前 HEAD：${unrelatedHead.slice(0, 12)}`));
    assert.doesNotMatch(status, /不是 execution Git 基线|完成路径仍需处理：[\\s\\S]*HEAD/);
    await command(started.executionId, started.token!, ['implementation', 'complete']);
    const result = await readAgentCommandSubmission(started.executionId);
    assert.equal(result?.outcome, 'completed');
    assert.equal(result?.changedFiles, undefined);
    await completeExecution(started.executionId);
  } finally {
    git(['reset', '--hard', originalHead], paths.root);
  }
});
