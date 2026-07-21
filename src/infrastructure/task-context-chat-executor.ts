import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAgentFinalTextAccumulator, resolveCursorAgentLaunch } from './agent-executor';
import { createTemporaryPrompt, removeTemporaryPrompt } from './delegation-execution';
import type { AgentExecutorId } from '../domain/agent-executor';
import type { AgentExecutionOptions } from './agent-executor';
import { paths } from './database';

type ContextChatRun = {
  taskId: string;
  executor: AgentExecutorId;
  providerSessionId: string | null;
  message: string;
  executionOptions: AgentExecutionOptions;
};

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

export function taskContextChatPermissionArgs(executor: AgentExecutorId) {
  if (executor === 'cursor') return ['--force', '--trust'];
  if (executor === 'claude') return ['--dangerously-skip-permissions'];
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function runProcess(command: string, args: string[], input?: string, timeoutMs = 10 * 60 * 1000, envOverrides: Record<string, string | undefined> = {}) {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: paths.root,
      env: { ...process.env, ...envOverrides },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function commandPath(value: string) {
  return JSON.stringify(value);
}

export function buildTaskContextChatPrompt(taskId: string, message: string, firstTurn: boolean) {
  const freshness = [
    '在回答涉及当前状态、文档、活动、规格、问题或验证证据的问题前，必须重新运行只读命令获取最新事实；不要依赖会话中较早的事实。',
    `完整任务上下文：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-context ${taskId}`,
    `任务摘要：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-get ${taskId}`,
    `推进队列：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-pipeline ${taskId}`,
    `文档列表：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-list --task-id ${taskId}`,
    `读取文档：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-get --task-id ${taskId} --kind <kind> [--story <n>]`,
  ].join('\n');
  const contract = firstTurn ? [
    '你是 LoopWork 中当前需求唯一会话的上下文查询 Agent。你的职责是帮助用户理解需求、仓库代码、交付文档、活动记录、执行状态和证据。',
    `当前需求固定为 ${taskId}。LoopWork 应用根目录为 ${paths.appRoot}，目标仓库根目录为 ${paths.root}。`,
    '你只能读取和解释，不能修改代码、文件、Git、数据库、需求状态、文档、评论、问题或 Loop 调度状态。不能运行任何会产生写入、副作用、网络发布或进程控制的命令。',
    '允许使用原生只读工具和命令，包括 Read、Glob、Grep、rg、sed，以及 git status --short、git diff、git log、git show。使用 Shell 时也必须保持只读。',
    '禁止调用 task-update、task-context-init、task-rewind、task-cancel、system-unblock、document-upsert、question-add 或任何其他写命令。用户要求你执行变更时，说明本会话只负责查询，并指出应通过文档反馈、澄清回答或正常 Loop 完成。',
    '回答应简洁直接。涉及 LoopWork 事实时尽量给出可核对引用：文档 ID/版本/交付单元、事件 actor/时间，或仓库文件路径与行号。不要声称已经执行任何未执行的操作。',
  ].join('\n') : '继续遵守本会话首轮的只读职责与工具边界。';
  return `${contract}\n\n${freshness}\n\n用户问题：\n${message}`;
}

function finalText(executor: AgentExecutorId, stdout: string) {
  const accumulator = createAgentFinalTextAccumulator(executor);
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) accumulator.ingest(line);
  return accumulator.value().trim();
}

function codexSessionId(stdout: string) {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (event.type === 'thread.started' && event.thread_id) return event.thread_id;
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return '';
}

export async function runTaskContextChatTurn(input: ContextChatRun) {
  const firstTurn = !input.providerSessionId;
  const prompt = buildTaskContextChatPrompt(input.taskId, input.message, firstTurn);
  let providerSessionId = input.providerSessionId || '';
  let result: ProcessResult;

  if (input.executor === 'cursor') {
    const launch = resolveCursorAgentLaunch();
    if (!providerSessionId) {
      const created = await runProcess(launch.command, [...launch.prefixArgs, 'create-chat'], undefined, 10 * 60 * 1000, launch.env);
      if (created.exitCode !== 0) throw new Error(`Cursor 无法创建上下文会话：${created.stderr.trim() || `exit ${created.exitCode}`}`);
      providerSessionId = created.stdout.trim().split(/\s+/).at(-1) || '';
      if (!providerSessionId) throw new Error('Cursor 未返回会话 ID');
    }
    const temporary = createTemporaryPrompt(prompt);
    try {
      result = await runProcess(launch.command, [
        ...launch.prefixArgs,
        '--print', '--output-format', 'stream-json', ...taskContextChatPermissionArgs('cursor'), '--resume', providerSessionId,
        temporary.reference,
      ], undefined, 10 * 60 * 1000, launch.env);
    } finally {
      removeTemporaryPrompt(temporary);
    }
  } else if (input.executor === 'claude') {
    providerSessionId ||= randomUUID();
    result = await runProcess(process.env.CLAUDE_CLI || 'claude', [
      '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      ...taskContextChatPermissionArgs('claude'), '--tools', 'Read,Glob,Grep,Bash',
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(firstTurn ? ['--session-id', providerSessionId] : ['--resume', providerSessionId]),
    ], prompt);
  } else {
    const common = [
      '--json', ...taskContextChatPermissionArgs('codex'),
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(input.executionOptions.reasoningEffort ? ['--config', `model_reasoning_effort="${input.executionOptions.reasoningEffort}"`] : []),
    ];
    result = firstTurn
      ? await runProcess(process.env.CODEX_CLI || 'codex', ['exec', ...common, '-C', paths.root, '-'], prompt)
      : await runProcess(process.env.CODEX_CLI || 'codex', ['exec', 'resume', ...common, providerSessionId, '-'], prompt);
    if (firstTurn) providerSessionId = codexSessionId(result.stdout);
  }

  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${input.executor} 上下文 Agent 执行失败：${diagnostic || `exit ${result.exitCode}`}`);
  }
  if (!providerSessionId) throw new Error(`${input.executor} 未返回可恢复的会话 ID`);
  const answer = finalText(input.executor, result.stdout);
  if (!answer) throw new Error(`${input.executor} 上下文 Agent 没有返回回答`);
  return { answer, providerSessionId };
}
