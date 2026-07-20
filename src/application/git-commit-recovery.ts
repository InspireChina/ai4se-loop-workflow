import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { databaseConnection } from '../infrastructure/database';

export const GIT_COMMIT_TEMPLATE_SETTING = 'git_commit_message_template';
export const GIT_COMMIT_TEMPLATE_PLACEHOLDERS = [
  '{taskId}', '{externalId}', '{unit}', '{type}', '{description}', '{operation}', '{title}',
] as const;

export type GitCommitOperation = 'checkpoint' | 'delivery';

export type GitCommitResolutionRequest = {
  request_id: string;
  task_id: string;
  execution_id: string | null;
  story_index: number;
  operation: GitCommitOperation;
  status: 'pending' | 'answered' | 'applied' | 'superseded';
  attempted_message: string;
  error_output: string;
  answer_message: string | null;
  remembered_template: string | null;
  created_at: string;
  answered_at: string | null;
  applied_at: string | null;
};

type CommitContext = {
  task_id: string;
  title: string;
  external_id: string | null;
};

const oneLine = z.string().trim().min(1).max(1000).refine((value) => !/[\r\n]/.test(value), 'Git 提交标题必须为单行文本');
const answerSchema = z.object({
  taskId: z.string().min(1),
  requestId: z.string().min(1),
  commitMessage: oneLine,
  rememberTemplate: z.coerce.boolean().default(false),
  messageTemplate: z.string().trim().max(1000).optional().default(''),
});

function operationValues(context: CommitContext, storyIndex: number, operation: GitCommitOperation) {
  const checkpoint = operation === 'checkpoint';
  const singleLine = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  return {
    taskId: singleLine(context.task_id),
    externalId: singleLine(context.external_id) || 'N/A',
    unit: String(storyIndex),
    type: checkpoint ? 'chore' : 'feat',
    description: checkpoint ? `checkpoint before ${context.task_id} Unit-${storyIndex}` : `Unit-${storyIndex} 完成实现`,
    operation,
    title: singleLine(context.title),
  };
}

export function renderGitCommitTemplate(templateInput: string, context: CommitContext, storyIndex: number, operation: GitCommitOperation) {
  const template = oneLine.parse(templateInput);
  const values = operationValues(context, storyIndex, operation);
  const unknown = Array.from(template.matchAll(/\{([^{}]+)\}/g), (match) => match[1]).filter((key) => !(key in values));
  if (unknown.length) throw new Error(`未知 Git 提交模板变量：${Array.from(new Set(unknown)).join(', ')}`);
  return oneLine.parse(template.replace(/\{([^{}]+)\}/g, (_match, key: keyof typeof values) => values[key]));
}

function defaultMessage(context: CommitContext, storyIndex: number, operation: GitCommitOperation) {
  return operation === 'checkpoint'
    ? `chore(loop): checkpoint before ${context.task_id} Unit-${storyIndex}`
    : `feat(${context.task_id}): Unit-${storyIndex} 完成实现`;
}

export async function gitCommitMessageFor(taskId: string, storyIndex: number, operation: GitCommitOperation) {
  const db = await databaseConnection();
  const context = db.prepare('SELECT task_id, title, external_id FROM tasks WHERE task_id = ?').get(taskId) as CommitContext | undefined;
  if (!context) throw new Error(`需求不存在：${taskId}`);
  const answered = db.prepare(`
    SELECT * FROM git_commit_resolution_requests
    WHERE task_id = ? AND story_index = ? AND operation = ? AND status = 'answered'
    ORDER BY answered_at DESC, created_at DESC LIMIT 1
  `).get(taskId, storyIndex, operation) as GitCommitResolutionRequest | undefined;
  if (answered?.answer_message) return { message: oneLine.parse(answered.answer_message), requestId: answered.request_id, source: 'answer' as const };
  const setting = db.prepare('SELECT setting_value FROM project_settings WHERE setting_key = ?').get(GIT_COMMIT_TEMPLATE_SETTING) as { setting_value: string } | undefined;
  if (setting?.setting_value) {
    return { message: renderGitCommitTemplate(setting.setting_value, context, storyIndex, operation), requestId: null, source: 'repository_template' as const };
  }
  return { message: defaultMessage(context, storyIndex, operation), requestId: null, source: 'default' as const };
}

export class GitCommitInputRequiredError extends Error {
  constructor(
    public readonly operation: GitCommitOperation,
    public readonly attemptedMessage: string,
    public readonly detail: string,
    public readonly sourceRequestId: string | null = null,
  ) {
    super(detail);
    this.name = 'GitCommitInputRequiredError';
  }
}

export async function requestGitCommitInput(input: {
  taskId: string;
  storyIndex: number;
  operation: GitCommitOperation;
  attemptedMessage: string;
  errorOutput: string;
  executionId?: string | null;
  sourceRequestId?: string | null;
}) {
  const db = await databaseConnection();
  const existing = db.prepare(`
    SELECT * FROM git_commit_resolution_requests
    WHERE task_id = ? AND story_index = ? AND operation = ? AND status = 'pending'
  `).get(input.taskId, input.storyIndex, input.operation) as GitCommitResolutionRequest | undefined;
  if (existing) return existing.request_id;
  const requestId = randomUUID();
  db.transaction(() => {
    if (input.sourceRequestId) {
      db.prepare("UPDATE git_commit_resolution_requests SET status = 'superseded' WHERE request_id = ? AND status = 'answered'").run(input.sourceRequestId);
    }
    db.prepare(`
      INSERT INTO git_commit_resolution_requests(
        request_id, task_id, execution_id, story_index, operation,
        attempted_message, error_output
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, input.taskId, input.executionId || null, input.storyIndex, input.operation,
      oneLine.parse(input.attemptedMessage), String(input.errorOutput).slice(0, 12000),
    );
    db.prepare(`
      UPDATE tasks
      SET run_state = 'waiting_for_git_input', blocked_reason = ?, next_step = ?,
          last_actor = 'system', resume_pending = 0, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      `Git ${input.operation === 'checkpoint' ? 'checkpoint' : '交付'}提交需要补充仓库要求的信息`,
      '等待补充合规的 Git 提交标题', input.taskId,
    );
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'system', 'GitCommitInputRequested', ?)
    `).run(randomUUID(), input.taskId, `仓库拒绝 ${input.operation} 提交，等待补充合规提交标题。`);
  })();
  return requestId;
}

export async function answerGitCommitInput(input: unknown) {
  const value = answerSchema.parse(input);
  const db = await databaseConnection();
  const request = db.prepare('SELECT * FROM git_commit_resolution_requests WHERE request_id = ? AND task_id = ?').get(value.requestId, value.taskId) as GitCommitResolutionRequest | undefined;
  if (!request || request.status !== 'pending') throw new Error('Git 提交信息请求不存在或已经处理');
  if (value.rememberTemplate && !value.messageTemplate) throw new Error('选择记住仓库规则时必须填写提交标题模板');
  if (value.messageTemplate) {
    const context = db.prepare('SELECT task_id, title, external_id FROM tasks WHERE task_id = ?').get(value.taskId) as CommitContext;
    renderGitCommitTemplate(value.messageTemplate, context, request.story_index, request.operation);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE git_commit_resolution_requests
      SET status = 'answered', answer_message = ?, remembered_template = ?, answered_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(value.commitMessage, value.rememberTemplate ? value.messageTemplate : null, value.requestId);
    if (value.rememberTemplate) {
      db.prepare(`
        INSERT INTO project_settings(setting_key, setting_value)
        VALUES(?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
      `).run(GIT_COMMIT_TEMPLATE_SETTING, value.messageTemplate);
    }
    db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', blocked_reason = NULL,
          next_step = 'Git 提交信息已补充，等待从提交阶段继续',
          last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND run_state = 'waiting_for_git_input'
    `).run(value.taskId);
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'human', 'GitCommitInputAnswered', '已补充 Git 提交标题，等待继续提交。')
    `).run(randomUUID(), value.taskId);
  })();
}

export async function markGitCommitInputApplied(requestId: string | null | undefined) {
  if (!requestId) return;
  const db = await databaseConnection();
  db.prepare(`
    UPDATE git_commit_resolution_requests
    SET status = 'applied', applied_at = CURRENT_TIMESTAMP
    WHERE request_id = ? AND status = 'answered'
  `).run(requestId);
}

export async function listGitCommitResolutionRequests(taskId: string) {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT * FROM git_commit_resolution_requests
    WHERE task_id = ? ORDER BY created_at DESC, request_id DESC
  `).all(taskId) as GitCommitResolutionRequest[];
}
