import { randomUUID } from 'node:crypto';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import { loopAgentCommandPrefix } from '../domain/agent-command-profile';
import { claimNextIntervention, finishInterventionAttempt, openInterventionInDb, reconcileInterventions, runInterventionCommand } from './interventions';

type Db = Awaited<ReturnType<typeof databaseConnection>>;

export const VERIFICATION_ASSISTANCE_MIN_ATTEMPTS = 3;

type AssistanceJobRow = {
  job_id: string;
  intervention_id: string | null;
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
  itemId?: string | null;
}) {
  const existing = db.prepare(`
    SELECT job_id, intervention_id FROM verification_assistance_jobs WHERE request_id = ?
  `).get(input.requestId) as { job_id: string; intervention_id: string | null } | undefined;
  if (existing) return existing.job_id;
  const request = db.prepare(`
    SELECT source_agent, source_execution_id, question, why, recommendation
    FROM runtime_input_requests WHERE request_id = ? AND task_id = ?
  `).get(input.requestId, input.taskId) as {
    source_agent: string;
    source_execution_id: string | null;
    question: string;
    why: string | null;
    recommendation: string | null;
  } | undefined;
  if (!request) throw new Error(`验证协助请求不存在：${input.requestId}`);
  const intervention = openInterventionInDb(db, {
    taskId: input.taskId,
    itemId: input.itemId || null,
    dedupeKey: `verification-assistance:${input.requestId}`,
    summary: input.title,
    context: {
      verificationRequestId: input.requestId,
      storyIndex: input.storyIndex,
      question: request.question,
      why: request.why,
      recommendation: request.recommendation,
    },
    requestedBy: request.source_agent,
    sourceExecutionId: request.source_execution_id,
    resolverStrategy: 'system_then_human',
    authority: 'standard',
    maxSystemAttempts: VERIFICATION_ASSISTANCE_MIN_ATTEMPTS,
    emitEvent: false,
  });
  const jobId = `VA-${randomUUID()}`;
  db.prepare(`
    INSERT INTO verification_assistance_jobs(
      job_id, request_id, task_id, story_index, max_attempts, intervention_id
    ) VALUES(?, ?, ?, ?, ?, ?)
  `).run(jobId, input.requestId, input.taskId, input.storyIndex, VERIFICATION_ASSISTANCE_MIN_ATTEMPTS, intervention.intervention_id);
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

export async function claimNextVerificationAssistance(input: {
  runId: string;
  executorId: string;
  executionOptions: AgentExecutionOptions;
}): Promise<ClaimedVerificationAssistance | null> {
  const claimed = await claimNextIntervention({ ...input, legacyVerificationOnly: true });
  if (!claimed) return null;
  const db = await databaseConnection();
  const row = db.prepare(
    'SELECT job.job_id, request.request_id, request.story_index, request.title, request.question, request.why, request.recommendation FROM verification_assistance_jobs job JOIN runtime_input_requests request ON request.request_id = job.request_id WHERE job.intervention_id = ?',
  ).get(claimed.interventionId) as {
    job_id: string;
    request_id: string;
    story_index: number | null;
    title: string;
    question: string;
    why: string | null;
    recommendation: string | null;
  };
  return {
    jobId: row.job_id,
    requestId: row.request_id,
    taskId: claimed.taskId,
    storyIndex: row.story_index,
    executionId: claimed.executionId,
    sessionId: claimed.sessionId,
    token: claimed.token,
    attempt: claimed.attempt,
    maxAttempts: claimed.maxAttempts,
    title: row.title,
    question: row.question,
    why: row.why,
    recommendation: row.recommendation,
    taskTitle: claimed.taskTitle,
    previousReasons: claimed.previousErrors,
  };
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

export async function finishVerificationAssistanceAttempt(input: {
  jobId: string;
  reason: string;
  outcome: 'deferred' | 'failed';
}) {
  const db = await databaseConnection();
  const row = db.prepare(
    'SELECT intervention_id FROM verification_assistance_jobs WHERE job_id = ?',
  ).get(input.jobId) as { intervention_id: string | null } | undefined;
  if (!row?.intervention_id) return { ignored: true as const, willRetry: false, escalated: false };
  return finishInterventionAttempt({
    interventionId: row.intervention_id,
    reason: input.reason,
    outcome: input.outcome,
  });
}

export async function runVerificationAssistanceCommand(input: {
  jobId: string;
  sessionId: string;
  token: string;
  args: string[];
}) {
  const db = await databaseConnection();
  const row = db.prepare(
    'SELECT intervention_id FROM verification_assistance_jobs WHERE job_id = ?',
  ).get(input.jobId) as { intervention_id: string | null } | undefined;
  if (!row?.intervention_id) throw new Error('当前验证协助任务不存在、已经结束或不再需要处理');
  const action = input.args[1];
  if (input.args[0] !== 'verification-assistance' || !['status', 'resolve', 'defer'].includes(action || '')) {
    throw new Error('未知验证协助命令；请使用 verification-assistance status');
  }
  const args = input.args.map((arg, index) => index === 0 ? 'intervention' : arg === '--answer' ? '--resolution' : arg);
  let output: string;
  try {
    output = await runInterventionCommand({
      interventionId: row.intervention_id,
      sessionId: input.sessionId,
      token: input.token,
      args,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('尚未查看介入事项状态')) {
      throw new Error('本次启动尚未查看验证协助状态，请先执行 verification-assistance status');
    }
    throw error;
  }
  if (action === 'status') {
    db.prepare(
      'UPDATE verification_assistance_jobs SET status_viewed_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?',
    ).run(input.sessionId, input.jobId);
    return output;
  }
  if (action === 'resolve') {
    return '验证协助已由系统辅助 Agent 解决；在没有其他待处理请求时，验证 Agent 将自动恢复原计划。';
  }
  const current = db.prepare('SELECT status FROM interventions WHERE intervention_id = ?')
    .get(row.intervention_id) as { status: string };
  return current.status === 'awaiting_human'
    ? '本次尝试未解决，已转交人工。'
    : '本次尝试未解决，系统将启动下一次尝试。';
}

export async function verificationAssistanceJobStatus(jobId: string) {
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT job.*,
           intervention.status AS source_status,
           (SELECT COUNT(*) FROM intervention_attempts attempt
            WHERE attempt.intervention_id = intervention.intervention_id
              AND attempt.status IN ('running', 'deferred', 'failed', 'resolved')) AS source_attempt_count,
           intervention.max_system_attempts AS source_max_attempts,
           intervention.active_session_id AS source_active_session_id,
           intervention.command_token_hash AS source_command_token_hash,
           intervention.status_viewed_session_id AS source_status_viewed_session_id,
           intervention.current_execution_id AS source_current_execution_id,
           intervention.resolution AS source_answer,
           intervention.last_error AS source_last_reason
    FROM verification_assistance_jobs job
    JOIN interventions intervention ON intervention.intervention_id = job.intervention_id
    WHERE job.job_id = ?
  `).get(jobId) as (AssistanceJobRow & {
    source_status: string;
    source_attempt_count: number;
    source_max_attempts: number;
    source_active_session_id: string | null;
    source_command_token_hash: string | null;
    source_status_viewed_session_id: string | null;
    source_current_execution_id: string | null;
    source_answer: string | null;
    source_last_reason: string | null;
  }) | undefined;
  if (!row) return undefined;
  return {
    ...row,
    status: row.source_status === 'awaiting_human' ? 'escalated' : row.source_status as AssistanceJobRow['status'],
    attempt_count: row.source_attempt_count,
    max_attempts: row.source_max_attempts,
    active_session_id: row.source_active_session_id,
    command_token_hash: row.source_command_token_hash,
    status_viewed_session_id: row.source_status_viewed_session_id,
    current_execution_id: row.source_current_execution_id,
    answer: row.source_answer,
    last_reason: row.source_last_reason,
  };
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
  return reconcileInterventions();
}
