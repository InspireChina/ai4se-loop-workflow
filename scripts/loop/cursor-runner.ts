#!/usr/bin/env tsx
import '../load-env.js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLoopRunLog, createLoopDispatch, endRun, getRunStatus } from '../../src/application/tasks';
import { startCursorAgentRun, startDispatchRetryRun } from '../../src/infrastructure/cursor-agent';
import { paths } from '../../src/infrastructure/database';

const leaseId = process.argv[2];
if (!leaseId) throw new Error('missing lease id');

function compact(value: string, limit = 1600) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function isCursorDiagnosticStderr(line: string) {
  return /^cursor-retrieval:\s+tracing to\b/.test(line.trim());
}

function logCursorStderrLine(line: string) {
  const text = compact(line);
  return `${isCursorDiagnosticStderr(text) ? '[Cursor诊断]' : '[Cursor错误]'} ${text}`;
}

function stringifyValue(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolPayload(event: Record<string, unknown>) {
  const toolCall = event.tool_call as Record<string, unknown> | undefined;
  if (!toolCall) return { tool: '', args: undefined as Record<string, unknown> | undefined, result: undefined as Record<string, unknown> | undefined };
  const key = Object.keys(toolCall).find((item) => item.endsWith('ToolCall'));
  const payload = key ? toolCall[key] as Record<string, unknown> : undefined;
  const tool = key ? key.replace(/ToolCall$/, '') : stringifyValue(event.tool || event.name || '');
  return {
    tool,
    args: payload?.args as Record<string, unknown> | undefined,
    result: payload?.result as Record<string, unknown> | undefined,
  };
}

function summarizeCommand(command: string) {
  if (!command) return '';
  if (command.includes(' pipeline-all ')) return '获取本轮 pipeline 委派';
  if (command.includes(' run-log ')) return '写入 Agent 运行日志';
  if (command.includes(' task-get ') || command.includes(' task-show ')) return '查询 Task 详情';
  if (command.includes(' task-context-init ')) return '初始化本地上下文';
  if (command.includes(' task-update ')) return '更新 Task 状态';
  if (command.includes(' paths')) return '查看工作区路径配置';
  if (command.includes('--help')) return '查看 loopctl 可用命令';
  return compact(command);
}

function summarizeResult(result: Record<string, unknown> | undefined) {
  if (!result) return '';
  const success = result.success as Record<string, unknown> | undefined;
  const failure = result.error as Record<string, unknown> | undefined;
  if (failure) return `失败：${compact(stringifyValue(failure), 500)}`;
  if (!success) return compact(stringifyValue(result), 500);
  const exitCode = success.exitCode !== undefined ? `exit=${success.exitCode}` : '';
  const stdout = stringifyValue(success.stdout);
  const files = Array.isArray(success.files) ? `files=${success.files.length}` : '';
  const matches = stringifyValue((success.workspaceResults as Record<string, unknown> | undefined) || '');
  const summary = stdout ? `输出 ${stdout.split(/\r?\n/).filter(Boolean).length} 行：${compact(stdout, 500)}` : files || (matches ? '找到匹配结果' : '成功');
  return [exitCode, summary].filter(Boolean).join('，');
}

function logCursorJsonLine(line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || event.event || event.kind || 'event');
    const subtype = String(event.subtype || '');
    const { tool, args, result } = getToolPayload(event);
    const text = stringifyValue(event.text || event.message || event.delta || event.content || event.summary);
    if (type === 'tool_call' || tool) {
      const description = stringifyValue(args?.description) || stringifyValue((event.tool_call as Record<string, unknown> | undefined)?.description);
      const command = stringifyValue(args?.command);
      const path = stringifyValue(args?.path || args?.targetDirectory);
      const message = subtype === 'completed'
        ? summarizeResult(result)
        : description || summarizeCommand(command) || path || '执行工具';
      return `[Cursor工具] ${subtype === 'completed' ? '完成' : '调用'} tool=${tool || 'unknown'} - ${compact(message || text || '工具事件')}`;
    }
    if (text) return `[Cursor输出] type=${type} - ${compact(text)}`;
    return `[Cursor事件] ${compact(line)}`;
  } catch {
    return `[Cursor输出] ${compact(line)}`;
  }
}

function buildPrompt(loopCommand: string) {
  return [
    '你是 Loop Engineering 的 Cursor Agent 执行器。',
    '',
    '请执行本轮 loop。注意：本轮 run lease 已经由 App 创建，不要再调用 run-begin。',
    '不要调用 run-end，也不要释放 run lease；本产品是持续 loop，运行生命周期由 App 的“结束本轮”按钮控制。',
    '完成当前可执行委派后，记录必要日志，然后直接结束本次 Cursor Agent 输出。App runner 会在 1 分钟后自动继续下一轮 loop。',
    '',
    `Run Token: ${leaseId}`,
    `Loop App Root: ${paths.appRoot}`,
    `Workspace Root: ${paths.root}`,
    '',
    '所有状态读取和写入必须通过：',
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} ...`,
    '',
    '关键动作必须写入运行日志：',
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event start --message "开始处理"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event tool-call --tool TOOL --message "准备调用工具"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event tool-result --tool TOOL --message "工具结果摘要"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event complete --message "处理完成"`,
    '',
    '需要人工确认时，不要写 90_questions.md / 90_analysis_questions.md / 91_test_questions.md。必须提交结构化 JSON 到 questions 表：',
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} question-add --json '{"taskId":"TASK-id","actor":"analyst-agent","kind":"analysis","storyIndex":1,"blockedReason":"等待用户确认业务规则","blockTask":true,"questions":[{"title":"问题标题","question":"需要用户回答的具体问题","why":"为什么必须确认","recommendation":"建议答案，可为空"}]}'`,
    '可一次提交多个 questions；UI 会在 Task 详情页逐条展示并让用户回答。',
    '',
    '下面是 /loop 原始协议，请遵守；其中 run-begin/run-end 步骤在 App 持续运行模式下必须忽略：',
    '',
    loopCommand,
  ].join('\n');
}

function delayLabel(ms: number) {
  return ms >= 60000 ? `${Math.max(1, Math.round(ms / 60000))} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLeaseActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.leaseId === leaseId);
}

async function scheduleNextLoop() {
  const retryMs = Number(process.env.LOOP_ACTIVE_DISPATCH_RETRY_MS || 60 * 1000);
  await appendLoopRunLog(leaseId, `[运行] 本轮 agent 已完成，${delayLabel(retryMs)}后继续 loop`);
  await sleep(retryMs);
  if (!(await isLeaseActive())) return;

  await appendLoopRunLog(leaseId, '[运行] 继续下一轮派发');
  const dispatch = await createLoopDispatch(leaseId, { includeRunHeader: false });
  if (dispatch.delegations.length > 0) {
    await appendLoopRunLog(leaseId, `[运行] 下一轮发现 ${dispatch.delegations.length} 个 agent，启动 Cursor Agent`);
    await startCursorAgentRun(leaseId);
    return;
  }
  await startDispatchRetryRun(leaseId);
}

async function main() {
  const loopCommand = await readFile(join(paths.appRoot, '.cursor/commands/loop.md'), 'utf8');
  const prompt = buildPrompt(loopCommand);
  const cursorBin = process.env.CURSOR_CLI || 'cursor';
  const args = ['agent', '--print', '--output-format', 'stream-json', '--trust', '--force', '--workspace', paths.root, prompt];
  const maxRuntimeMs = Number(process.env.CURSOR_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
  const idleTimeoutMs = Number(process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
  let lastOutputAt = Date.now();
  let timedOut = false;
  let logQueue = Promise.resolve();

  const enqueueLog = (message: string) => {
    logQueue = logQueue.catch(() => undefined).then(() => appendLoopRunLog(leaseId, message)).catch(() => undefined);
  };

  const flushLogs = async () => {
    await logQueue;
  };

  await appendLoopRunLog(leaseId, `[Cursor] 启动 Cursor Agent：${cursorBin} agent --print --output-format stream-json --force --workspace ${paths.root}`);

  const child = spawn(cursorBin, args, {
    cwd: paths.root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    lastOutputAt = Date.now();
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) enqueueLog(logCursorJsonLine(line));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    lastOutputAt = Date.now();
    stderrBuffer += chunk.toString('utf8');
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) enqueueLog(logCursorStderrLine(line));
  });

  const terminate = async (reason: string) => {
    if (timedOut) return;
    timedOut = true;
    await appendLoopRunLog(leaseId, `[Cursor] ${reason}，正在终止 Cursor Agent`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000).unref();
  };

  const maxTimer = setTimeout(() => void terminate(`超过最大运行时间 ${Math.round(maxRuntimeMs / 1000)} 秒`), maxRuntimeMs);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastOutputAt > idleTimeoutMs) void terminate(`超过空闲时间 ${Math.round(idleTimeoutMs / 1000)} 秒`);
  }, Math.min(30000, idleTimeoutMs));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(maxTimer);
  clearInterval(idleTimer);
  if (stdoutBuffer.trim()) enqueueLog(logCursorJsonLine(stdoutBuffer));
  if (stderrBuffer.trim()) enqueueLog(logCursorStderrLine(stderrBuffer));
  await flushLogs();
  await appendLoopRunLog(leaseId, `[Cursor] Cursor Agent 已退出 code=${exitCode ?? 'signal'}`);
  await scheduleNextLoop();
}

main().catch(async (error) => {
  await appendLoopRunLog(leaseId, `[Cursor错误] ${error instanceof Error ? error.message : String(error)}`);
  await endRun(leaseId, true, { stopRunner: false });
});
