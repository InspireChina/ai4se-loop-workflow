import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAgentFinalTextAccumulator, resolveCursorAgentLaunch } from './agent-executor';
import { createTemporaryPrompt, removeTemporaryPrompt } from './delegation-execution';
import type { AgentExecutorId } from '../domain/agent-executor';
import type { AgentExecutionOptions } from './agent-executor';
import { paths } from './database';

type ContextChatRun = {
  taskId: string;
  sessionId: string;
  messageId: string;
  executor: AgentExecutorId;
  providerSessionId: string | null;
  message: string;
  commandToken: string;
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

export function buildTaskContextChatPrompt(
  taskId: string,
  message: string,
  firstTurn: boolean,
) {
  const freshness = [
    '在回答涉及当前状态、文档、活动、规格、问题或验证证据的问题前，必须重新运行只读命令获取最新事实；不要依赖会话中较早的事实。',
    '上下文对话独立于 Loop Runner。即使 Loop 尚未启动或当前已停止，也必须直接基于当前需求记录和已经产出的文档继续工作。',
    `完整任务上下文（包含当前需求已经产出的文档）：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-context --task-id ${taskId}`,
    `任务摘要：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-get ${taskId}`,
    `推进队列：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-pipeline ${taskId}`,
    `文档列表：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-list --task-id ${taskId}`,
    `读取文档：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-get --task-id ${taskId} --kind <kind> [--story <n>]`,
  ].join('\n');
  const changeCommand = `npm --prefix ${commandPath(paths.appRoot)} run loopctl -- context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图> [--acceptance <验收关注>]`;
  const commonContract = [
    '你是 LoopWork 中当前需求唯一会话的上下文 Agent。你的职责是帮助用户理解需求、仓库代码、交付文档、活动记录、执行状态和证据，并把用户确认需要实施的变化提交到向前追加的 Feedback 闭环。',
    `当前需求固定为 ${taskId}。LoopWork 应用根目录为 ${paths.appRoot}，目标仓库根目录为 ${paths.root}。`,
    '每轮都必须重新读取最新需求事实；不要把较早轮次中的需求、状态或代码结论当作当前事实。',
    '始终禁止修改目标仓库文件或 Git，也禁止直接修改 Loop 数据库、需求状态、既有交付单元、交付文档、问题、Agent 配置、权限、密钥、环境配置或调度状态，禁止发布和部署。',
    '禁止调用 task-update、story-add、task-context-init、task-rewind、task-cancel、system-unblock、document-upsert、question-add 或任何其他 Loop 写命令。唯一允许的写操作是下方当前会话绑定的 context-chat-change 领域命令。',
    '回答应简洁直接。涉及 LoopWork 事实时尽量给出可核对引用：文档 ID/版本/交付单元、事件 actor/时间，或仓库文件路径与行号。不要声称已经执行任何未执行的操作。',
    '允许使用 Read、Glob、Grep、rg、sed、git status --short、git diff、git log、git show 等只读工具；使用 Shell 时也必须保持只读。',
    '如果用户只是询问、解释、比较或探索方案，直接回答，不创建变更请求。',
    '如果用户明确希望改变当前产品行为、界面、文案、代码或技术实现，先读取上下文判断其确实是需要实施的新变化，再按独立业务闭环拆成边界清楚的变更请求。',
    `提交变更请求：${changeCommand}`,
    '命令成功表示请求已经进入与详情文档评论相同的 Feedback 闭环。不要直接声称交付单元已经创建；Feedback Agent 会先判断它是回复、缺陷、行为修订、范围新增还是技术调整，需要实施的工作会先由交付规划 Agent 形成完整的向前追加交付单元，再经过 Analysis、Dev、Test 和独立反馈验证。',
    '同一个 Chat turn 可以调用任意多次 context-chat-change，没有数量上限。每个独立变化使用不同的稳定 key；同一变化重试时必须复用原 key，Application 会返回原记录而不是重复创建。',
    '一个变更请求可以由交付规划 Agent 规划成一个或多个完整交付单元；Chat、Feedback Agent 和 Harness 都不得预设交付单元数量上限。',
    '命令失败时根据完整错误修正参数并重试；如果提示需求尚未形成交付单元或已经终态，向用户说明当前不能在本需求追加。',
    '普通回复中说明结论；若已成功调用命令，明确说明提交了多少条变更请求、后续将由 Loop 判断并追加所需数量的交付单元。不要返回 JSON。',
  ];
  const contract = [
    ...(firstTurn ? [] : ['本轮能力契约会覆盖旧轮次中“可以直接轻量修改代码”的过时说明。']),
    ...commonContract,
  ].join('\n');
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
  const chatCommandEnv = {
    LOOP_CONTEXT_CHAT_SESSION_ID: input.sessionId,
    LOOP_CONTEXT_CHAT_MESSAGE_ID: input.messageId,
    LOOP_CONTEXT_CHAT_COMMAND_TOKEN: input.commandToken,
  };
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
      ], undefined, 10 * 60 * 1000, { ...launch.env, ...chatCommandEnv });
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
    ], prompt, 10 * 60 * 1000, chatCommandEnv);
  } else {
    const common = [
      '--json', ...taskContextChatPermissionArgs('codex'),
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(input.executionOptions.reasoningEffort ? ['--config', `model_reasoning_effort="${input.executionOptions.reasoningEffort}"`] : []),
    ];
    result = firstTurn
      ? await runProcess(process.env.CODEX_CLI || 'codex', ['exec', ...common, '-C', paths.root, '-'], prompt, 10 * 60 * 1000, chatCommandEnv)
      : await runProcess(process.env.CODEX_CLI || 'codex', ['exec', 'resume', ...common, providerSessionId, '-'], prompt, 10 * 60 * 1000, chatCommandEnv);
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
