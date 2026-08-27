import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import { loopAgentCommandPrefix } from '../domain/agent-command-profile';
import { agentConcurrencyInDb } from './project-settings';
import { setTaskLaneStateInDb } from './task-lanes';

type Db = Awaited<ReturnType<typeof databaseConnection>>;

export const VERIFICATION_ASSISTANCE_MIN_ATTEMPTS = 3;

type AssistanceJobRow = {
  job_id: string;
  request_id: string;
  task_id: string;
  story_index: number | null;
  status: 'pending' | 'running' | 'resolved' | 'escalated' | 'cancelled';
  attempt_count: number;
  max_attempts: number;
  active_session_id: string | null;
  command_token_hash: string | null;
  status_viewed_session_id: string | null;
  current_execution_id: string | null;
  answer: string | null;
  last_reason: string | null;
};

type AssistanceRequestRow = AssistanceJobRow & {
  title: string;
  question: string;
  why: string | null;
  recommendation: string | null;
  request_status: string;
  task_title: string;
};

export type ClaimedVerificationAssistance = {
  jobId: string;
  requestId: string;
  taskId: string;
  storyIndex: number | null;
  executionId: string;
  sessionId: string;
  token: string;
  attempt: number;
  maxAttempts: number;
  title: string;
  question: string;
  why: string | null;
  recommendation: string | null;
  taskTitle: string;
  previousReasons: string[];
};

function addEvent(db: Db, taskId: string, eventType: string, summary: string) {
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, 'system', ?, ?)
  `).run(randomUUID(), taskId, eventType, summary);
}

export function queueVerificationAssistanceInDb(db: Db, input: {
  requestId: string;
  taskId: string;
  storyIndex: number | null;
  title: string;
}) {
  const existing = db.prepare(`
    SELECT job_id FROM verification_assistance_jobs WHERE request_id = ?
  `).get(input.requestId) as { job_id: string } | undefined;
  if (existing) return existing.job_id;
  const jobId = `VA-${randomUUID()}`;
  db.prepare(`
    INSERT INTO verification_assistance_jobs(
      job_id, request_id, task_id, story_index, max_attempts
    ) VALUES(?, ?, ?, ?, ?)
  `).run(jobId, input.requestId, input.taskId, input.storyIndex, VERIFICATION_ASSISTANCE_MIN_ATTEMPTS);
  db.prepare(`
    UPDATE tasks
    SET next_step = ?, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?
  `).run(`系统辅助 Agent 将先自动处理验证协助（最多 ${VERIFICATION_ASSISTANCE_MIN_ATTEMPTS} 次）：${input.title}`, input.taskId);
  addEvent(
    db,
    input.taskId,
    'VerificationAssistanceQueued',
    `验证协助已先交给系统辅助 Agent，最多尝试 ${VERIFICATION_ASSISTANCE_MIN_ATTEMPTS} 次：${input.title}`,
  );
  return jobId;
}

function activeAgentCount(db: Db) {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM execution_attempts
    WHERE status IN ('planned', 'running')
  `).get() as { count: number }).count;
}

export async function claimNextVerificationAssistance(input: {
  runId: string;
  executorId: string;
  executionOptions: AgentExecutionOptions;
}): Promise<ClaimedVerificationAssistance | null> {
  const db = await databaseConnection();
  return db.transaction(() => {
    if (activeAgentCount(db) >= agentConcurrencyInDb(db)) return null;
    const row = db.prepare(`
      SELECT job.*, request.title, request.question, request.why, request.recommendation,
             request.status AS request_status, task.title AS task_title
      FROM verification_assistance_jobs job
      JOIN runtime_input_requests request ON request.request_id = job.request_id
      JOIN tasks task ON task.task_id = job.task_id
      WHERE job.status = 'pending'
        AND job.attempt_count < job.max_attempts
        AND request.status = 'pending'
        AND task.is_paused = 0
        AND task.agile_status NOT IN ('done', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM verification_assistance_jobs active
          WHERE active.task_id = job.task_id AND active.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM execution_attempts active_execution
          WHERE active_execution.task_id = job.task_id
            AND active_execution.agent = 'system-assistance-agent'
            AND active_execution.status IN ('planned', 'running')
        )
      ORDER BY job.created_at, job.job_id
      LIMIT 1
    `).get() as AssistanceRequestRow | undefined;
    if (!row) return null;

    const attempt = row.attempt_count + 1;
    const executionId = randomUUID();
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const snapshot = {
      jobId: row.job_id,
      requestId: row.request_id,
      taskId: row.task_id,
      storyIndex: row.story_index,
      attempt,
      maxAttempts: row.max_attempts,
      title: row.title,
      question: row.question,
      why: row.why,
      recommendation: row.recommendation,
    };
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, run_id, task_id, story_index, agent, pipeline, lane,
        delegation_key, attempt, status, input_hash, input_json, heartbeat_at,
        started_at, executor_id, configured_model, reasoning_effort
      ) VALUES(?, ?, ?, ?, 'system-assistance-agent', 'verification-assistance', 'control',
        ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)
    `).run(
      executionId,
      input.runId,
      row.task_id,
      row.story_index,
      `verification-assistance:${row.job_id}`,
      attempt,
      hash(JSON.stringify(snapshot)),
      JSON.stringify(snapshot),
      input.executorId,
      input.executionOptions.model || null,
      input.executionOptions.reasoningEffort || null,
    );
    db.prepare(`
      UPDATE verification_assistance_jobs
      SET status = 'running', attempt_count = ?, active_session_id = ?,
          command_token_hash = ?, status_viewed_session_id = NULL,
          current_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND status = 'pending'
    `).run(attempt, sessionId, hash(token), executionId, row.job_id);
    db.prepare(`
      INSERT INTO verification_assistance_attempts(
        attempt_id, job_id, execution_id, attempt
      ) VALUES(?, ?, ?, ?)
    `).run(randomUUID(), row.job_id, executionId, attempt);
    db.prepare(`
      UPDATE tasks SET next_step = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?
    `).run(`系统辅助 Agent 正在处理验证协助（第 ${attempt}/${row.max_attempts} 次）：${row.title}`, row.task_id);
    addEvent(
      db,
      row.task_id,
      'VerificationAssistanceAttemptStarted',
      `系统辅助 Agent 开始第 ${attempt}/${row.max_attempts} 次尝试：${row.title}`,
    );
    const previousReasons = (db.prepare(`
      SELECT reason FROM verification_assistance_attempts
      WHERE job_id = ? AND attempt < ? AND reason IS NOT NULL
      ORDER BY attempt
    `).all(row.job_id, attempt) as { reason: string }[]).map((item) => item.reason);
    return {
      jobId: row.job_id,
      requestId: row.request_id,
      taskId: row.task_id,
      storyIndex: row.story_index,
      executionId,
      sessionId,
      token,
      attempt,
      maxAttempts: row.max_attempts,
      title: row.title,
      question: row.question,
      why: row.why,
      recommendation: row.recommendation,
      taskTitle: row.task_title,
      previousReasons,
    };
  }).immediate();
}

export function buildVerificationAssistancePrompt(job: ClaimedVerificationAssistance) {
  const command = loopAgentCommandPrefix(paths.appRoot);
  const previous = job.previousReasons.length
    ? job.previousReasons.map((reason, index) => `${index + 1}. ${reason}`).join('\n')
    : '无；这是首次尝试。';
  return [
    '# 角色目标',
    '你是 LoopWork 的系统辅助 Agent。验证 Agent 因缺少执行条件或可靠证据提出了验证协助。你要先代表人工尽力调查并解决，让无人值守流程继续。',
    '',
    '# 当前请求',
    `需求：${job.taskTitle}（${job.taskId}）`,
    `交付单元：${job.storyIndex ?? '需求级'}`,
    `尝试：${job.attempt}/${job.maxAttempts}`,
    `标题：${job.title}`,
    `问题：${job.question}`,
    `原因：${job.why || '未提供'}`,
    `建议：${job.recommendation || '未提供'}`,
    '',
    '# 先前尝试',
    previous,
    '',
    '# 工作规则',
    '1. 必须先执行 verification-assistance status，然后读取最新任务上下文、相关代码、运行环境和已有验证证据。',
    '2. 优先自行补齐本机可获得的条件：发现真实入口、启动或检查本地服务、构造非敏感测试数据、运行测试或最小复现、检查日志与配置。不得仅因请求原本写给人工就直接放弃。',
    '3. 可以执行只影响当前验证的安全、可恢复操作；不得修改产品代码、Loop 数据库、需求/通道状态、权限、密钥或外部生产环境，不得伪造观察。',
    '4. 只有取得足以让验证 Agent继续原计划的真实信息、环境入口、执行结果或证据时才能 resolve。答案必须写清执行了什么、实际观察、证据位置及限制。',
    '5. 如果安全能力范围内仍无法解决，执行 defer，准确说明已尝试动作、失败证据，以及最终必须由人提供的最小信息或动作。普通最终文本不会结束本次尝试。',
    '',
    '# 可用领域命令',
    `查看状态：${command} verification-assistance status`,
    `成功解决：${command} verification-assistance resolve --answer-file <UTF-8 答复文件>`,
    `本次无法解决：${command} verification-assistance defer --reason-file <UTF-8 原因文件>`,
    `完整任务上下文：npm --prefix ${JSON.stringify(paths.appRoot)} run loopctl -- task-context --task-id ${job.taskId}`,
    `任务摘要：npm --prefix ${JSON.stringify(paths.appRoot)} run loopctl -- task-get ${job.taskId}`,
    '',
    '先执行 status，随后开始真实调查；结束前必须成功调用 resolve 或 defer。',
  ].join('\n');
}

function authorizedJob(db: Db, input: { jobId: string; sessionId: string; token: string }) {
  const row = db.prepare(`
    SELECT job.*, request.title, request.question, request.why, request.recommendation,
           request.status AS request_status, task.title AS task_title
    FROM verification_assistance_jobs job
    JOIN runtime_input_requests request ON request.request_id = job.request_id
    JOIN tasks task ON task.task_id = job.task_id
    WHERE job.job_id = ?
  `).get(input.jobId) as AssistanceRequestRow | undefined;
  if (!row || row.status !== 'running' || row.request_status !== 'pending') {
    throw new Error('当前验证协助任务不存在、已经结束或不再需要处理');
  }
  if (row.active_session_id !== input.sessionId) throw new Error('当前验证协助会话已经失效');
  if (!row.command_token_hash || hash(input.token) !== row.command_token_hash) {
    throw new Error('当前验证协助命令凭证无效');
  }
  return row;
}

function assertStatusViewed(row: AssistanceJobRow, sessionId: string) {
  if (row.status_viewed_session_id !== sessionId) {
    throw new Error('本次启动尚未查看验证协助状态，请先执行 verification-assistance status');
  }
}

function renderStatus(row: AssistanceRequestRow) {
  return [
    '# VERIFICATION ASSISTANCE',
    '',
    `- Job: ${row.job_id}`,
    `- Attempt: ${row.attempt_count}/${row.max_attempts}`,
    `- Requirement: ${row.task_id}`,
    `- Delivery Unit: ${row.story_index ?? 'task'}`,
    `- Request: ${row.title}`,
    `- Question: ${row.question}`,
    `- Why: ${row.why || '未提供'}`,
    `- Recommendation: ${row.recommendation || '未提供'}`,
    `- Previous Failure: ${row.last_reason || '无'}`,
    '',
    '# TERMINAL COMMANDS',
    '- `verification-assistance resolve --answer-file <答复文件>`',
    '- `verification-assistance defer --reason-file <原因文件>`',
  ].join('\n');
}

function resumeVerificationLaneIfReady(db: Db, row: AssistanceRequestRow) {
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_input_requests
    WHERE task_id = ? AND source_agent IN ('dev-agent', 'test-agent') AND status = 'pending'
  `).get(row.task_id) as { count: number }).count;
  if (pending) return false;
  const lane = db.prepare(`
    SELECT current_agent, current_story_index FROM task_lanes
    WHERE task_id = ? AND lane = 'delivery' AND status = 'waiting_for_runtime_input'
  `).get(row.task_id) as { current_agent: string | null; current_story_index: number | null } | undefined;
  if (!lane?.current_agent) return false;
  db.prepare(`
    UPDATE tasks
    SET run_state = 'runnable', resume_pending = 0, blocked_reason = NULL,
        next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?
  `).run(`系统辅助 Agent 已补齐验证协助，交回 ${lane.current_agent} 从原验证计划继续`, row.task_id);
  setTaskLaneStateInDb(db, {
    taskId: row.task_id,
    lane: 'delivery',
    status: 'runnable',
    currentAgent: lane.current_agent,
    currentStoryIndex: lane.current_story_index,
    resumePending: 1,
  });
  addEvent(db, row.task_id, 'RuntimeInputsSubmitted', `系统辅助 Agent 已提交验证协助，交回 ${lane.current_agent}。`);
  return true;
}

function resolveJob(db: Db, row: AssistanceRequestRow, answer: string) {
  const normalized = z.string().trim().min(1).max(8000).parse(answer);
  db.prepare(`
    UPDATE runtime_input_requests
    SET answer = ?, status = 'answered', updated_at = CURRENT_TIMESTAMP
    WHERE request_id = ? AND status = 'pending'
  `).run(normalized, row.request_id);
  db.prepare(`
    UPDATE verification_assistance_jobs
    SET status = 'resolved', answer = ?, command_token_hash = NULL,
        resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(normalized, row.job_id);
  db.prepare(`
    UPDATE verification_assistance_attempts
    SET status = 'resolved', answer = ?, finished_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND attempt = ?
  `).run(normalized, row.job_id, row.attempt_count);
  db.prepare(`
    UPDATE execution_attempts
    SET result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status = 'running'
  `).run(JSON.stringify({ outcome: 'completed', verdict: 'resolved', summary: normalized }), row.current_execution_id);
  addEvent(
    db,
    row.task_id,
    'VerificationAssistanceResolved',
    `系统辅助 Agent 在第 ${row.attempt_count}/${row.max_attempts} 次尝试中解决验证协助「${row.title}」。`,
  );
  resumeVerificationLaneIfReady(db, row);
}

export async function finishVerificationAssistanceAttempt(input: {
  jobId: string;
  reason: string;
  outcome: 'deferred' | 'failed';
}) {
  const reason = z.string().trim().min(1).max(8000).parse(input.reason);
  const db = await databaseConnection();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT job.*, request.title, request.question, request.why, request.recommendation,
             request.status AS request_status, task.title AS task_title
      FROM verification_assistance_jobs job
      JOIN runtime_input_requests request ON request.request_id = job.request_id
      JOIN tasks task ON task.task_id = job.task_id
      WHERE job.job_id = ?
    `).get(input.jobId) as AssistanceRequestRow | undefined;
    if (!row || row.status !== 'running') {
      return { ignored: true as const, willRetry: false, escalated: row?.status === 'escalated' };
    }
    const escalated = row.attempt_count >= row.max_attempts;
    const nextStatus = escalated ? 'escalated' : 'pending';
    db.prepare(`
      UPDATE verification_assistance_jobs
      SET status = ?, last_reason = ?, active_session_id = NULL,
          command_token_hash = NULL, status_viewed_session_id = NULL,
          current_execution_id = NULL, updated_at = CURRENT_TIMESTAMP,
          escalated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE escalated_at END
      WHERE job_id = ?
    `).run(nextStatus, reason, escalated ? 1 : 0, row.job_id);
    db.prepare(`
      UPDATE verification_assistance_attempts
      SET status = ?, reason = ?, finished_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND attempt = ?
    `).run(input.outcome, reason, row.job_id, row.attempt_count);
    if (input.outcome === 'failed') {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'retryable_failed', result_json = ?, last_error = ?,
            failure_kind = 'verification-assistance', heartbeat_at = CURRENT_TIMESTAMP,
            finished_at = CURRENT_TIMESTAMP
        WHERE execution_id = ? AND status = 'running'
      `).run(
        JSON.stringify({ outcome: 'needs_input', verdict: input.outcome, summary: reason }),
        reason,
        row.current_execution_id,
      );
    } else {
      db.prepare(`
        UPDATE execution_attempts
        SET result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
        WHERE execution_id = ? AND status = 'running'
      `).run(
        JSON.stringify({ outcome: 'needs_input', verdict: input.outcome, summary: reason }),
        row.current_execution_id,
      );
    }
    const nextStep = escalated
      ? `系统辅助 Agent 已尝试 ${row.attempt_count} 次仍无法解决，等待人工验证协助：${row.title}`
      : `系统辅助 Agent 第 ${row.attempt_count}/${row.max_attempts} 次未解决，将继续自动尝试：${row.title}`;
    db.prepare('UPDATE tasks SET next_step = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?')
      .run(nextStep, row.task_id);
    addEvent(
      db,
      row.task_id,
      escalated ? 'VerificationAssistanceEscalated' : 'VerificationAssistanceAttemptDeferred',
      escalated
        ? `系统辅助 Agent 已尝试 ${row.attempt_count} 次仍无法解决「${row.title}」，现转交人工：${reason}`
        : `系统辅助 Agent 第 ${row.attempt_count}/${row.max_attempts} 次未解决「${row.title}」，将继续自动尝试：${reason}`,
    );
    return { ignored: false as const, willRetry: !escalated, escalated, attempt: row.attempt_count, maxAttempts: row.max_attempts };
  }).immediate();
}

export async function runVerificationAssistanceCommand(input: {
  jobId: string;
  sessionId: string;
  token: string;
  args: string[];
}) {
  const commandParts: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < input.args.length; index += 1) {
    const item = input.args[index]!;
    if (!item.startsWith('--')) {
      commandParts.push(item);
      continue;
    }
    const next = input.args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${item} 必须提供值`);
    flags.set(item.slice(2), next);
    index += 1;
  }
  const command = commandParts.join(' ');
  const db = await databaseConnection();
  const row = authorizedJob(db, input);
  if (command === 'verification-assistance status') {
    db.prepare(`
      UPDATE verification_assistance_jobs
      SET status_viewed_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(input.sessionId, row.job_id);
    return renderStatus({ ...row, status_viewed_session_id: input.sessionId });
  }
  assertStatusViewed(row, input.sessionId);
  if (command === 'verification-assistance resolve') {
    const answer = flags.get('answer')?.trim();
    if (!answer) throw new Error('缺少 --answer 或 --answer-file');
    db.transaction(() => resolveJob(db, row, answer)).immediate();
    return '验证协助已由系统辅助 Agent 解决；在没有其他待处理请求时，验证 Agent 将自动恢复原计划。';
  }
  if (command === 'verification-assistance defer') {
    const reason = flags.get('reason')?.trim();
    if (!reason) throw new Error('缺少 --reason 或 --reason-file');
    const result = await finishVerificationAssistanceAttempt({ jobId: row.job_id, reason, outcome: 'deferred' });
    return result.escalated
      ? `第 ${row.attempt_count}/${row.max_attempts} 次尝试未解决，已转交人工。`
      : `第 ${row.attempt_count}/${row.max_attempts} 次尝试未解决，系统将启动下一次尝试。`;
  }
  throw new Error(`未知命令：${command || '(empty)'}。请使用 verification-assistance status`);
}

export async function verificationAssistanceJobStatus(jobId: string) {
  const db = await databaseConnection();
  return db.prepare('SELECT * FROM verification_assistance_jobs WHERE job_id = ?').get(jobId) as AssistanceJobRow | undefined;
}

export async function completeVerificationAssistanceExecution(executionId: string) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'applied', heartbeat_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status = 'running'
  `).run(executionId);
}

export async function reconcileVerificationAssistanceJobs() {
  const db = await databaseConnection();
  const stale = db.prepare(`
    SELECT job.job_id
    FROM verification_assistance_jobs job
    LEFT JOIN execution_attempts execution ON execution.execution_id = job.current_execution_id
    WHERE job.status = 'running'
      AND (execution.execution_id IS NULL OR execution.status NOT IN ('planned', 'running'))
  `).all() as { job_id: string }[];
  for (const item of stale) {
    await finishVerificationAssistanceAttempt({
      jobId: item.job_id,
      reason: '系统辅助 Agent 上次运行未正常收尾，已由 Runner 恢复并重新尝试',
      outcome: 'failed',
    });
  }
  return stale.length;
}
