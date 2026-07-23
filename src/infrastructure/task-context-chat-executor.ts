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
  writeAllowed: boolean;
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
  options: { writeAllowed?: boolean } = {},
) {
  const freshness = [
    '在回答涉及当前状态、文档、活动、规格、问题或验证证据的问题前，必须重新运行只读命令获取最新事实；不要依赖会话中较早的事实。',
    `完整任务上下文：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-context ${taskId}`,
    `任务摘要：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-get ${taskId}`,
    `推进队列：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- task-pipeline ${taskId}`,
    `文档列表：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-list --task-id ${taskId}`,
    `读取文档：npm --prefix ${commandPath(paths.appRoot)} run loopctl -- document-get --task-id ${taskId} --kind <kind> [--story <n>]`,
  ].join('\n');
  const commonContract = [
    '你是 LoopWork 中当前需求唯一会话的上下文与轻量修改 Agent。你的职责是帮助用户理解需求、仓库代码、交付文档、活动记录、执行状态和证据，并在明确边界内执行小型界面修改。',
    `当前需求固定为 ${taskId}。LoopWork 应用根目录为 ${paths.appRoot}，目标仓库根目录为 ${paths.root}。`,
    '每轮都必须重新读取最新需求事实；不要把较早轮次中的需求、状态或代码结论当作当前事实。',
    '始终禁止修改 Loop 数据库、需求状态、交付文档、评论、问题、Agent 配置、权限、密钥、环境配置或调度状态，也禁止发布和部署。',
    '禁止调用 task-update、task-context-init、task-rewind、task-cancel、system-unblock、document-upsert、question-add 或任何其他 Loop 写命令。代码修改只能遵守本轮下方给出的能力边界。',
    '回答应简洁直接。涉及 LoopWork 事实时尽量给出可核对引用：文档 ID/版本/交付单元、事件 actor/时间，或仓库文件路径与行号。不要声称已经执行任何未执行的操作。',
  ];
  const writeContract = options.writeAllowed ? [
    '当前没有 Dev Agent 或 Test Agent 占用工作区，本轮已获得轻量代码修改权限。即使旧会话中曾出现“只读”说明，也以本轮更新后的能力边界为准。',
    '用户当前消息本身就是授权，不需要再次请求确认。你必须自行判断请求是否同时满足：改动小、局部、可快速验证、不违背当前需求和已经对齐的用户决策。',
    '允许的典型范围是 UI 呈现、布局、样式、可访问性和 wording。没有固定路径白名单，但改动语义必须保持轻量。',
    '不得借此改变业务规则、验收标准、API 契约、数据模型、数据库 schema/migration、权限、安全边界、依赖或基础设施。若请求涉及这些内容，或与需求文档/用户决策冲突，停止修改并直接说明应通过文档反馈或正常 Loop 对齐。',
    '修改前先读取任务上下文并检查 git status --short，保留工作区里原有的其他改动。只编辑当前请求需要的文件，只暂存并提交自己本轮的修改。',
    '完成修改后运行与改动最相关的最小验证。验证通过才创建一个 Git commit；提交信息应清楚说明这是 UI 或 wording 轻量修改。',
    '如果无法让验证通过，必须撤销自己本轮产生的全部文件修改，不提交代码，并向用户说明失败原因。不得回退、覆盖或提交进入本轮前已存在的改动。',
    '普通回复中说明实际修改、验证结果和 commit；不要返回 JSON。无须推动或更改 Loop 状态。',
  ] : [
    '当前有 Dev Agent、Test Agent 或另一个轻量修改 Chat 正在占用工作区。为避免相互干扰，本轮只允许读取和解释，不能修改代码、文件或 Git。',
    '允许使用 Read、Glob、Grep、rg、sed、git status --short、git diff、git log、git show 等只读工具。使用 Shell 时也必须保持只读。',
    '如果用户要求代码变更，说明当前工作区正在被其他执行占用，本轮不能写入；不要用任何方式绕过。',
  ];
  const contract = [
    ...(firstTurn ? [] : ['本轮能力契约会覆盖旧轮次中已经过时的只读说明。']),
    ...commonContract,
    ...writeContract,
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
  const prompt = buildTaskContextChatPrompt(input.taskId, input.message, firstTurn, {
    writeAllowed: input.writeAllowed,
  });
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
