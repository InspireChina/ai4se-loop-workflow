import { documentFilesRoot } from './document-files';
import { loadExternalCommandPrompt, mergeExternalCommandOptions } from './external-command-prompts';
import { buildAgentProcessLaunch } from './delegation-execution';
import { getAgentExecutor } from './agent-executor';
import { join } from 'node:path';
import { assertSupportedAgentExecutor } from '../domain/agent-executor';
import { spawn } from 'node:child_process';
import { createAgentFinalTextAccumulator, parseAgentTelemetryStdoutEvents } from './agent-executor';
import { resolveAgentExecutionLimits } from './agent-execution-limits';
import { sanitizeDiagnosticText } from './diagnostic-text';
import { terminateProcessTree } from './process-tree';
import type { AgentExecutorId } from '../domain/agent-executor';
import type { AgentExecutionOptions } from './agent-executor';
import type { ExecutionRecoveryMode } from '../application/execution-retry-policy';
import { paths } from './database';

export type TaskContextChatRecoveryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ContextChatRun = {
  taskId: string;
  sessionId: string;
  messageId: string;
  executor: AgentExecutorId;
  providerSessionId: string | null;
  message: string;
  commandToken: string;
  workspaceRoot?: string;
  executionOptions: AgentExecutionOptions;
  recoveryMode?: ExecutionRecoveryMode;
  retryNumber?: number;
  maxRetries?: number;
  recoveryMessages?: readonly TaskContextChatRecoveryMessage[];
  onProgress?: (event: TaskContextChatProgressEvent) => void;
};

export type TaskContextChatProgressEvent = {
  kind: 'thinking' | 'tool' | 'status';
  label: string;
  detail?: string;
  status: 'running' | 'completed' | 'error';
};

type ProcessResult = { exitCode: number; stdout: string; stderr: string; terminationReason?: string };


function runProcess(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 4 * 60 * 60 * 1000,
  envOverrides: Record<string, string | undefined> = {},
  startupTimeoutMs = 20 * 60 * 1000,
  idleTimeoutMs = 30 * 60 * 1000,
  onStdoutLine?: (line: string) => void,
  workspaceRoot = paths.root,
) {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...envOverrides },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stdoutPending = '';
    let stderr = '';
    let terminationReason = '';
    let startupTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    const terminate = async (reason: string) => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      const terminated = child.pid
        ? await terminateProcessTree(child.pid, 5_000).catch(() => false)
        : false;
      if (!terminated) child.kill('SIGKILL');
    };
    const noteOutput = () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void terminate(`超过空闲时间 ${Math.ceil(idleTimeoutMs / 1000)} 秒`);
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    const publishStdoutLines = (text: string, flush = false) => {
      stdoutPending += text;
      const lines = stdoutPending.split(/\r?\n/);
      stdoutPending = flush ? '' : lines.pop() || '';
      const complete = flush && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
      for (const line of complete.filter(Boolean)) {
        try { onStdoutLine?.(line); } catch { /* UI progress must not affect execution */ }
      }
      if (flush && stdoutPending) {
        try { onStdoutLine?.(stdoutPending); } catch { /* UI progress must not affect execution */ }
        stdoutPending = '';
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      noteOutput();
      const text = chunk.toString('utf8');
      stdout += text;
      publishStdoutLines(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => { noteOutput(); stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    startupTimer = setTimeout(() => {
      void terminate(`启动后 ${Math.ceil(startupTimeoutMs / 1000)} 秒内没有任何输出`);
    }, startupTimeoutMs);
    startupTimer.unref();
    const timer = setTimeout(() => {
      void terminate(`超过最大运行时间 ${Math.ceil(timeoutMs / 1000)} 秒`);
    }, timeoutMs);
    timer.unref();
    child.once('close', (exitCode) => {
      publishStdoutLines('', true);
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, ...(terminationReason ? { terminationReason } : {}) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function progressText(value: unknown) {
  const text = sanitizeDiagnosticText(value, 900).replace(/\s+/g, ' ').trim();
  return text || '';
}

function providerThinking(executor: AgentExecutorId, line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const message = event.message as Record<string, unknown> | undefined;
    const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
    const emittedThinking = blocks
      .filter((block) => block.type === 'thinking' || block.type === 'reasoning')
      .map((block) => progressText(block.thinking || block.reasoning || block.text || block.summary))
      .filter(Boolean)
      .join(' ');
    if (emittedThinking) return emittedThinking;
    if (event.type === 'thinking' || event.type === 'reasoning') {
      return progressText(event.thinking || event.reasoning || event.text || event.summary);
    }
    return '';
  } catch {
    return '';
  }
}

function toolLabel(tool: string | undefined) {
  const normalized = (tool || '').toLowerCase();
  if (normalized === 'shell' || normalized === 'bash') return '终端命令';
  if (normalized === 'read') return '读取文件';
  if (normalized === 'grep' || normalized === 'glob') return '搜索代码';
  if (normalized === 'web_search') return '网页搜索';
  if (normalized === 'file_change') return '修改文件';
  if (normalized === 'mcp_tool_call') return '调用外部工具';
  if (normalized === 'tool') return '工具调用';
  return tool ? `调用 ${tool}` : '调用工具';
}

export function taskContextChatProgressEvents(executor: AgentExecutorId, line: string): TaskContextChatProgressEvent[] {
  const progress: TaskContextChatProgressEvent[] = [];
  const thinking = providerThinking(executor, line);
  if (thinking) progress.push({ kind: 'thinking', label: '思考进展', detail: thinking, status: 'running' });
  for (const event of parseAgentTelemetryStdoutEvents(executor, line)) {
    if (event.name !== 'loop.agent.tool') continue;
    const completed = event.phase === 'completed';
    const failed = completed && event.success === false;
    const label = toolLabel(event.tool);
    progress.push({
      kind: 'tool',
      label: completed ? `${label}${failed ? '失败' : '完成'}` : label,
      detail: completed
        ? failed ? `执行失败${event.exitCode == null ? '' : ` · exit ${event.exitCode}`}` : '执行完成'
        : progressText(event.summary || '正在执行'),
      status: failed ? 'error' : completed ? 'completed' : 'running',
    });
  }
  return progress;
}

function commandPath(value: string) {
  return JSON.stringify(value);
}

export function buildTaskContextChatPrompt(
  taskId: string,
  message: string,
  firstTurn: boolean,
  recovery: {
    mode?: ExecutionRecoveryMode;
    retryNumber?: number;
    maxRetries?: number;
    messages?: readonly TaskContextChatRecoveryMessage[];
  } = {},
  workspaceRoot = paths.root,
) {
  const freshness = [
    '在回答涉及当前状态、文档、活动、规格、问题或验证证据的问题前，必须重新运行只读命令获取最新事实；不要依赖会话中较早的事实。',
    '上下文对话独立于 Loop Runner。即使 Loop 尚未启动或当前已停止，也必须直接基于当前需求记录和已经产出的文档继续工作。',
    `完整任务上下文（包含当前需求已经产出的文档）：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-context --task-id ${taskId}`,
    `任务摘要：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-get ${taskId}`,
    `派发诊断：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-dispatch-inspect ${taskId}`,
    `Runner 状态：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- run-status`,
    `文档列表：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-list --task-id ${taskId}`,
    `读取文档：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-get --task-id ${taskId} --kind <kind> [--story <n>]`,
  ].join('\n');
  const changeCommand = `npm --prefix ${commandPath(paths.appRoot)} run loopctl -- context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图> [--acceptance <验收关注>]`;
  const commonContract = loadExternalCommandPrompt(workspaceRoot, 'context-chat-agent').prompt.replaceAll('{{change_command}}', changeCommand).replaceAll('{{task_id}}', taskId).replaceAll('{{workspace_root}}', workspaceRoot).replaceAll('{{app_root}}', paths.appRoot).split('\n');
  const contract = [
    ...(firstTurn ? [] : ['本轮双路径能力契约覆盖旧轮次中“Chat 只能只读或所有修改都必须进入 Feedback”的过时说明；以本轮安全边界为准。']),
    ...commonContract,
  ].join('\n');
  const recoveryMode = recovery.mode || 'initial';
  const recoveryLimit = recoveryMode === 'standard' ? 24_000 : recoveryMode === 'compact' ? 12_000 : recoveryMode === 'minimal' ? 4_000 : 0;
  const recoveryMessages = recoveryLimit
    ? renderTaskContextChatRecoveryTranscript(recovery.messages || [], recoveryLimit)
    : '';
  const recoveryPacket = recoveryMode === 'initial' ? '' : [
    `# Error Recovery · retry ${recovery.retryNumber || 1}/${recovery.maxRetries || 4} · ${recoveryMode === 'standard' ? '标准恢复包' : recoveryMode === 'compact' ? '压缩恢复包' : '最小恢复包'}`,
    '这是错误退出后的全新 Provider 会话。不要假设能够读取上一次会话的 thinking、工具输出或临时状态。',
    '先从下方持久化对话、最新任务事实、Git 和领域命令结果恢复；执行写操作前必须核对是否已经生效，避免重复副作用。',
    ...(recoveryMode === 'minimal' ? ['只读取回答当前问题所需的事实，不要展开完整需求历史。'] : []),
    ...(recoveryMessages ? ['', '# Persisted Conversation Recovery', recoveryMessages] : []),
  ].join('\n');
  return `${contract}\n\n${freshness}${recoveryPacket ? `\n\n${recoveryPacket}` : ''}\n\n用户问题：\n${message}`;
}

export function renderTaskContextChatRecoveryTranscript(
  messages: readonly TaskContextChatRecoveryMessage[],
  maxChars: number,
) {
  const selected: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item) continue;
    const label = item.role === 'user' ? '用户' : 'Agent';
    const available = Math.max(0, maxChars - used - label.length - 4);
    if (!available) break;
    const content = item.content.trim();
    const bounded = content.length <= available ? content : `${content.slice(0, Math.max(0, available - 1))}…`;
    selected.unshift(`${label}：${bounded}`);
    used += label.length + bounded.length + 2;
    if (bounded.length < content.length) break;
  }
  return selected.join('\n\n');
}

function finalText(executor: AgentExecutorId, stdout: string) {
  const accumulator = createAgentFinalTextAccumulator(executor);
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) accumulator.ingest(line);
  return accumulator.value().trim();
}

function ompSessionId(stdout: string) {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; id?: string };
      if (event.type === 'session' && event.id) return event.id;
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return '';
}

export async function runTaskContextChatTurn(input: ContextChatRun) {
  assertSupportedAgentExecutor(input.executor);
  const { maxRuntimeMs, startupTimeoutMs, idleTimeoutMs } = resolveAgentExecutionLimits(process.env);
  const runChatProcess = (
    command: string,
    args: string[],
    processInput?: string,
    environment: Record<string, string | undefined> = {},
    publishProgress = false,
  ) => runProcess(
    command,
    args,
    processInput,
    maxRuntimeMs,
    environment,
    startupTimeoutMs,
    idleTimeoutMs,
    publishProgress
      ? (line) => taskContextChatProgressEvents(input.executor, line).forEach((event) => input.onProgress?.(event))
      : undefined,
    input.workspaceRoot || paths.root,
  );
  const newProviderSession = !input.providerSessionId;
  const logicalFirstTurn = newProviderSession && !(input.recoveryMessages?.length);
  const prompt = buildTaskContextChatPrompt(input.taskId, input.message, logicalFirstTurn, {
    mode: input.recoveryMode,
    retryNumber: input.retryNumber,
    maxRetries: input.maxRetries,
    messages: input.recoveryMessages,
  }, input.workspaceRoot || paths.root);
  const chatCommandEnv = {
    LOOP_CONTEXT_CHAT_SESSION_ID: input.sessionId,
    LOOP_CONTEXT_CHAT_MESSAGE_ID: input.messageId,
    LOOP_CONTEXT_CHAT_COMMAND_TOKEN: input.commandToken,
    LOOP_AGENT_TMP_DIR: join(documentFilesRoot(), 'sessions', 'chat', input.sessionId, 'tmp'),
  };
  let providerSessionId = input.providerSessionId || '';
  const role = loadExternalCommandPrompt(input.workspaceRoot || paths.root, 'context-chat-agent');
  const launch = buildAgentProcessLaunch(getAgentExecutor('omp'), prompt, input.workspaceRoot || paths.root, {
    ...mergeExternalCommandOptions(role, input.executionOptions),
    systemPromptText: role.prompt.replaceAll('{{change_command}}', `npm --prefix ${commandPath(paths.appRoot)} run loopctl -- context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图> [--acceptance <验收关注>]`).replaceAll('{{task_id}}', input.taskId).replaceAll('{{workspace_root}}', input.workspaceRoot || paths.root).replaceAll('{{app_root}}', paths.appRoot),
    sessionDirectory: join(documentFilesRoot(), 'sessions', 'chat', input.sessionId),
  });
  const result = await runChatProcess(launch.command, [...launch.args, ...(!newProviderSession && providerSessionId ? ['--resume', providerSessionId] : [])], launch.input, { ...chatCommandEnv, ...launch.env }, true);
  if (newProviderSession) providerSessionId = ompSessionId(result.stdout);

  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${input.executor} 上下文 Agent 执行失败：${result.terminationReason || diagnostic || `exit ${result.exitCode}`}`);
  }
  if (!providerSessionId) throw new Error(`${input.executor} 未返回可恢复的会话 ID`);
  const answer = finalText(input.executor, result.stdout);
  if (!answer) throw new Error(`${input.executor} 上下文 Agent 没有返回回答`);
  return { answer, providerSessionId };
}
