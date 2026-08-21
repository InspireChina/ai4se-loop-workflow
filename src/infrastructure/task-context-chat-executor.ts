import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAgentFinalTextAccumulator, resolveCursorAgentLaunch } from './agent-executor';
import { resolveAgentExecutionLimits } from './agent-execution-limits';
import { createTemporaryPrompt, removeTemporaryPrompt } from './delegation-execution';
import { terminateProcessTree } from './process-tree';
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

type ProcessResult = { exitCode: number; stdout: string; stderr: string; terminationReason?: string };

export function taskContextChatPermissionArgs(executor: AgentExecutorId) {
  if (executor === 'cursor') return ['--force', '--trust'];
  if (executor === 'claude') return ['--dangerously-skip-permissions'];
  if (executor === 'omp') return ['--approval-mode', 'yolo'];
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function runProcess(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 4 * 60 * 60 * 1000,
  envOverrides: Record<string, string | undefined> = {},
  startupTimeoutMs = 20 * 60 * 1000,
  idleTimeoutMs = 30 * 60 * 1000,
) {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: paths.root,
      env: { ...process.env, ...envOverrides },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
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
    child.stdout?.on('data', (chunk: Buffer) => { noteOutput(); stdout += chunk.toString('utf8'); });
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
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, ...(terminationReason ? { terminationReason } : {}) });
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
    `派发诊断：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-dispatch-inspect ${taskId}`,
    `Runner 状态：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- run-status`,
    `文档列表：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-list --task-id ${taskId}`,
    `读取文档：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-get --task-id ${taskId} --kind <kind> [--story <n>]`,
  ].join('\n');
  const changeCommand = `npm --prefix ${commandPath(paths.appRoot)} run loopctl -- context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图> [--acceptance <验收关注>]`;
  const commonContract = [
    '你是 LoopWork 中当前需求唯一会话的上下文 Agent。你的职责是帮助用户理解当前事实，并在用户要求修改时严格选择“轻微调整直达”或“业务变化进入 Feedback”其中一条路径。',
    `当前需求固定为 ${taskId}。LoopWork 应用根目录为 ${paths.appRoot}，目标仓库根目录为 ${paths.root}。`,
    '每轮都必须重新读取最新需求事实；不要把较早轮次中的需求、状态或代码结论当作当前事实。',
    '始终禁止直接修改 Loop 数据库、需求状态、既有交付单元、交付文档、问题、Agent 配置、权限、密钥、Loop 环境配置或调度状态，禁止发布和部署。',
    '禁止调用 task-update、story-add、task-context-init、task-rewind、task-cancel、system-unblock、document-upsert、question-add 或任何其他 Loop 写命令。唯一允许的 Loop 写操作是下方当前会话绑定的 context-chat-change 领域命令；直接修改代码不等于修改 Loop 状态。',
    '回答应简洁直接。涉及 LoopWork 事实时尽量给出可核对引用：文档 ID/版本/交付单元、事件 actor/时间，或仓库文件路径与行号。不要声称已经执行任何未执行的操作。',
    '如果用户只是询问、解释、比较或探索方案，直接回答，不创建变更请求。',
    '如果用户明确要求修改，必须先读取原始需求、业务变化上下文、当前交付规格/结卡事实、相关代码和 Git 状态，再判断处理路径。不要仅凭“文案”“UI”“小改”等字样直接认定为轻微调整。',
    '【轻微调整直达】只有以下条件全部成立才允许直接修改目标仓库：变化仅是局部 UI 样式、排版、错别字或不改变含义的措辞优化；不改变原始需求、业务意图、参与者、规则、范围、可观察结果、验收语义、交付单元契约、验证关注点或测试 Oracle；不涉及领域逻辑、数据/Schema、API 契约、权限、安全、工作流、依赖、构建或运行配置；范围小且能用针对性检查可靠验证。任一条件不成立或无法确定，都必须走 Feedback。',
    '直接修改还必须处于安全窗口：先运行 Runner 状态命令并确认 idle；修改前记录 git status --short、git diff 和当前 HEAD；计划修改的文件在本轮开始前必须没有不属于你的改动，且不存在其他 Agent 正在写代码。安全窗口不成立时不要等待、抢占或覆盖，改走 Feedback。',
    '执行轻微调整时，只修改完成该调整所需的最少文件，保留所有既有改动；运行与改动相称的针对性测试，并在需要时运行类型检查或构建；最后检查完整 diff。检查通过后按仓库规范只暂存并提交本轮自己从干净基线修改的文件，不得把既有改动带入 commit。',
    '轻微调整直接完成后不要调用 context-chat-change，也不要修改任何 Loop 状态或把它描述成新交付单元；回复中明确说明实际改了什么、验证结果、涉及文件和 commit（如仓库允许提交）。如果无法安全完成或验证失败，不得声称完成；清晰说明原因，并在仍需要实施时改走 Feedback。',
    '【业务变化进入 Feedback】凡是改变产品行为、业务含义、范围、数据、接口、权限、流程、验收结果或正式技术约束的修改，以及缺陷修复、跨层改动、较大重构或无法可靠界定影响的请求，都不得直接改代码，必须按独立业务闭环拆成边界清楚的变更请求。',
    `提交变更请求：${changeCommand}`,
    '命令成功表示请求已经进入与详情文档评论相同的 Feedback 闭环。不要直接声称交付单元已经创建；Feedback Agent 会先判断它是回复、缺陷、行为修订、范围新增还是技术调整，需要实施的工作会先由交付规划 Agent 形成完整的向前追加交付单元，再经过 Analysis、Dev、Test 和独立反馈验证。',
    '同一个 Chat turn 可以调用任意多次 context-chat-change，没有数量上限。每个独立变化使用不同的稳定 key；同一变化重试时必须复用原 key，Application 会返回原记录而不是重复创建。',
    '一个变更请求可以由交付规划 Agent 规划成一个或多个完整交付单元；Chat、Feedback Agent 和 Harness 都不得预设交付单元数量上限。',
    '命令失败时根据完整错误修正参数并重试；如果提示需求尚未形成交付单元或已经终态，向用户说明当前不能在本需求追加。',
    '普通回复中说明结论；若已成功调用命令，明确说明提交了多少条变更请求、后续将由 Loop 判断并追加所需数量的交付单元。不要返回 JSON。每个修改意图只能选择一种路径，禁止一边直接修改同一内容一边又提交 Feedback。',
  ];
  const contract = [
    ...(firstTurn ? [] : ['本轮双路径能力契约覆盖旧轮次中“Chat 只能只读或所有修改都必须进入 Feedback”的过时说明；以本轮安全边界为准。']),
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
  const { maxRuntimeMs, startupTimeoutMs, idleTimeoutMs } = resolveAgentExecutionLimits(process.env);
  const runChatProcess = (
    command: string,
    args: string[],
    processInput?: string,
    environment: Record<string, string | undefined> = {},
  ) => runProcess(command, args, processInput, maxRuntimeMs, environment, startupTimeoutMs, idleTimeoutMs);
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
      const created = await runChatProcess(launch.command, [...launch.prefixArgs, 'create-chat'], undefined, launch.env);
      if (created.exitCode !== 0) throw new Error(`Cursor 无法创建上下文会话：${created.stderr.trim() || `exit ${created.exitCode}`}`);
      providerSessionId = created.stdout.trim().split(/\s+/).at(-1) || '';
      if (!providerSessionId) throw new Error('Cursor 未返回会话 ID');
    }
    const temporary = createTemporaryPrompt(prompt);
    try {
      result = await runChatProcess(launch.command, [
        ...launch.prefixArgs,
        '--print', '--output-format', 'stream-json', ...taskContextChatPermissionArgs('cursor'), '--resume', providerSessionId,
        temporary.reference,
      ], undefined, { ...launch.env, ...chatCommandEnv });
    } finally {
      removeTemporaryPrompt(temporary);
    }
  } else if (input.executor === 'claude') {
    providerSessionId ||= randomUUID();
    result = await runChatProcess(process.env.CLAUDE_CLI || 'claude', [
      '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      ...taskContextChatPermissionArgs('claude'), '--tools', 'Read,Glob,Grep,Bash',
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(firstTurn ? ['--session-id', providerSessionId] : ['--resume', providerSessionId]),
    ], prompt, chatCommandEnv);
  } else if (input.executor === 'omp') {
    result = await runChatProcess(process.env.OMP_CLI || 'omp', [
      '--mode', 'json', ...taskContextChatPermissionArgs('omp'),
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(input.executionOptions.reasoningEffort ? ['--thinking', input.executionOptions.reasoningEffort] : []),
      ...(!firstTurn && providerSessionId ? ['--resume', providerSessionId] : []),
    ], prompt, chatCommandEnv);
    if (firstTurn) providerSessionId = ompSessionId(result.stdout);
  } else {
    const common = [
      '--json', ...taskContextChatPermissionArgs('codex'),
      ...(input.executionOptions.model ? ['--model', input.executionOptions.model] : []),
      ...(input.executionOptions.reasoningEffort ? ['--config', `model_reasoning_effort="${input.executionOptions.reasoningEffort}"`] : []),
    ];
    const search = input.executionOptions.webSearch ? ['--search'] : [];
    result = firstTurn
      ? await runChatProcess(process.env.CODEX_CLI || 'codex', [...search, 'exec', ...common, '-C', paths.root, '-'], prompt, chatCommandEnv)
      : await runChatProcess(process.env.CODEX_CLI || 'codex', [...search, 'exec', 'resume', ...common, providerSessionId, '-'], prompt, chatCommandEnv);
    if (firstTurn) providerSessionId = codexSessionId(result.stdout);
  }

  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${input.executor} 上下文 Agent 执行失败：${result.terminationReason || diagnostic || `exit ${result.exitCode}`}`);
  }
  if (!providerSessionId) throw new Error(`${input.executor} 未返回可恢复的会话 ID`);
  const answer = finalText(input.executor, result.stdout);
  if (!answer) throw new Error(`${input.executor} 上下文 Agent 没有返回回答`);
  return { answer, providerSessionId };
}
