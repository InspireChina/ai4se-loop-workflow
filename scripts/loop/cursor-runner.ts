#!/usr/bin/env tsx
import '../load-env.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { appendLoopRunLog, createLoopDispatch, endRun, getRunStatus, type DelegationEnvelope } from '../../src/application/tasks';
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

function logCursorStderrLine(line: string, delegation?: DelegationEnvelope) {
  const text = compact(line);
  const meta = delegation ? `${delegationMeta(delegation)} - ` : '';
  return `${isCursorDiagnosticStderr(text) ? '[Cursor诊断]' : '[Cursor错误]'} ${meta}${text}`;
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
  if (command.includes(' task-context ')) return '读取数据库 Task 上下文';
  if (command.includes(' document-list ')) return '列出数据库文档';
  if (command.includes(' document-get ')) return '读取数据库文档';
  if (command.includes(' document-upsert ')) return '保存数据库文档';
  if (command.includes(' story-add ')) return '新增 Story';
  if (command.includes(' task-get ') || command.includes(' task-show ')) return '查询 Task 详情';
  if (command.includes(' task-context-init ')) return '初始化数据库上下文';
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

function delegationMeta(delegation: DelegationEnvelope) {
  return `agent=${delegation.agent} task=${delegation.taskId} story=${delegation.storyIndex ?? '-'} pipeline=${delegation.pipeline}`;
}

function logCursorJsonLine(line: string, delegation: DelegationEnvelope) {
  const meta = delegationMeta(delegation);
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
      return `[Cursor工具] ${meta} tool=${tool || 'unknown'} - ${subtype === 'completed' ? '完成' : '调用'}：${compact(message || text || '工具事件')}`;
    }
    if (text) return `[Cursor输出] ${meta} type=${type} - ${compact(text)}`;
    return `[Cursor事件] ${meta} - ${compact(line)}`;
  } catch {
    return `[Cursor输出] ${delegationMeta(delegation)} - ${compact(line)}`;
  }
}

function roleInstruction(delegation: DelegationEnvelope) {
  switch (delegation.agent) {
    case 'backlog-agent':
      return [
        '你是 backlog-agent。',
        '目标：读取 Task 上下文，完成分类、补充必要上下文，并把 Task 推进到 in plan、in repro 或 blocked。',
        '可用写入：task-context-init、task-update、question-add、document-upsert。',
      ].join('\n');
    case 'story-splitter-agent':
      return [
        '你是 story-splitter-agent。',
        '目标：把 Task 拆成可独立推进的 Story。使用 story-add --actor story-splitter-agent 逐条创建 Story。',
        '拆分完成后，用 task-update 推进状态；不要只更新 total_stories 而不创建 stories 记录。',
      ].join('\n');
    case 'analyst-agent':
      return [
        '你是 analyst-agent。',
        '目标：只分析当前 Story 的需求、验收标准、约束和实现方案。',
        '结论必须通过 document-upsert 写入 documents 表，kind 建议为 analysis。',
        '需要人工确认时，使用 question-add --json 创建结构化问题并阻塞 Task；不要猜测关键业务决策。',
      ].join('\n');
    case 'repro-agent':
      return [
        '你是 repro-agent。',
        '目标：复现 Bug、记录现象、环境、步骤、根因假设和最小证据。',
        '复现材料必须通过 document-upsert 写入 documents 表，kind 建议为 repro。',
      ].join('\n');
    case 'dev-agent':
      return [
        '你是 dev-agent。',
        '目标：只实现当前 Story 所需代码变更。可以读取和修改 workspace repo 中的产品代码。',
        '关键实现说明通过 document-upsert 写入 documents 表，kind 建议为 dev_note。',
        '完成后用 task-update 推进 dev_index；遇到阻塞时用 question-add 或 task-update blocked。',
      ].join('\n');
    case 'test-agent':
      return [
        '你是 test-agent。',
        '目标：对当前 Story 做黑盒/回归验证，记录测试命令、结果和问题。',
        '测试结论必须通过 document-upsert 写入 documents 表，kind 建议为 test_result。',
        '通过后用 task-update 推进 test_index；失败时按规则回流或阻塞。',
      ].join('\n');
    case 'review-agent':
      return [
        '你是 review-agent。',
        '目标：审查整个 Task 的交付完整性、风险和验收结果。',
        'review 结论必须通过 document-upsert 写入 documents 表，kind 建议为 review。',
        '需要人工批准时，使用 question-add --json 创建 review 问题并阻塞 Task。',
      ].join('\n');
    default:
      return `你是 ${delegation.agent}。只执行当前 delegation，不调度其他 agent。`;
  }
}

function documentKindForAgent(agent: string) {
  if (agent === 'backlog-agent') return 'context';
  if (agent === 'story-splitter-agent') return 'story_split';
  if (agent === 'repro-agent') return 'repro';
  if (agent === 'dev-agent') return 'dev_note';
  if (agent === 'test-agent') return 'test_result';
  if (agent === 'review-agent') return 'review';
  return 'analysis';
}

function questionKindForAgent(agent: string) {
  if (agent === 'review-agent') return 'review';
  if (agent === 'test-agent') return 'test';
  if (agent === 'analyst-agent') return 'analysis';
  return 'local';
}

function buildPrompt(delegation: DelegationEnvelope) {
  const loopctl = `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')}`;
  const documentKind = documentKindForAgent(delegation.agent);
  const questionKind = questionKindForAgent(delegation.agent);
  return [
    '你是 Loop Engineering 的单步 Agent 执行器。',
    '',
    '外部 App 已经完成 pipeline 派发。你只执行下面这一条 delegation。',
    '禁止调用 pipeline-all、run-begin、run-end。禁止调度或模拟其他 pipeline agent。',
    '可以在当前 delegation 范围内使用辅助 subagent 收集上下文或做局部分析；辅助 subagent 不得处理其他 Task/Story/delegation，不得推进状态，最终写库和状态更新必须由当前 agent 负责。',
    '完成当前 delegation 后，记录必要日志并退出；外部 runner 会决定下一步。',
    '',
    `Run Token: ${leaseId}`,
    `Loop App Root: ${paths.appRoot}`,
    `Workspace Root: ${paths.root}`,
    '',
    '当前 delegation JSON：',
    JSON.stringify({
      task_id: delegation.taskId,
      title: delegation.title,
      item_type: delegation.itemType,
      priority: delegation.priority,
      agile_status: delegation.agileStatus,
      current_subagent: delegation.currentSubagent,
      pipeline: delegation.pipeline,
      agent: delegation.agent,
      story_index: delegation.storyIndex,
      resource: delegation.resource,
      description: delegation.description,
      analysis_index: delegation.analysisIndex,
      dev_index: delegation.devIndex,
      test_index: delegation.testIndex,
      total_stories: delegation.totalStories,
      next_step: delegation.nextStep,
      blocked_reason: delegation.blockedReason,
    }, null, 2),
    '',
    roleInstruction(delegation),
    '',
    '所有状态读取和写入必须通过：',
    `${loopctl} ...`,
    '',
    '不要读写 .project、90_questions.md、06_review.md 或旧工作目录。业务上下文、问题、分析、复现、测试和 review 结论都必须落 SQLite。',
    '读取上下文：',
    `${loopctl} task-context --task-id ${delegation.taskId}`,
    `${loopctl} document-list --task-id ${delegation.taskId}`,
    `${loopctl} document-get --task-id ${delegation.taskId} --kind analysis --story ${delegation.storyIndex ?? 1}`,
    '',
    '写入数据库文档：',
    `${loopctl} document-upsert --json '{"taskId":"${delegation.taskId}","actor":"${delegation.agent}","kind":"${documentKind}","storyIndex":${delegation.storyIndex ?? 'null'},"title":"结论标题","format":"markdown","content":"结论正文"}'`,
    '常用 kind：context、story_split、analysis、repro、dev_note、test_result、review。',
    '',
    '关键动作必须写入运行日志：',
    `${loopctl} run-log --run-token ${leaseId} --agent ${delegation.agent} --task-id ${delegation.taskId} --story ${delegation.storyIndex ?? '-'} --pipeline ${delegation.pipeline} --event start --message "开始处理"`,
    `${loopctl} run-log --run-token ${leaseId} --agent ${delegation.agent} --task-id ${delegation.taskId} --story ${delegation.storyIndex ?? '-'} --pipeline ${delegation.pipeline} --event tool-call --tool TOOL --message "准备调用工具"`,
    `${loopctl} run-log --run-token ${leaseId} --agent ${delegation.agent} --task-id ${delegation.taskId} --story ${delegation.storyIndex ?? '-'} --pipeline ${delegation.pipeline} --event tool-result --tool TOOL --message "工具结果摘要"`,
    `${loopctl} run-log --run-token ${leaseId} --agent ${delegation.agent} --task-id ${delegation.taskId} --story ${delegation.storyIndex ?? '-'} --pipeline ${delegation.pipeline} --event complete --message "处理完成"`,
    '',
    '需要人工确认时，不要写 90_questions.md / 90_analysis_questions.md / 91_test_questions.md。必须提交结构化 JSON 到 questions 表：',
    `${loopctl} question-add --json '{"taskId":"${delegation.taskId}","actor":"${delegation.agent}","kind":"${questionKind}","storyIndex":${delegation.storyIndex ?? 'null'},"blockedReason":"等待用户确认","blockTask":true,"questions":[{"title":"问题标题","question":"需要用户回答的具体问题","why":"为什么必须确认","recommendation":"建议答案，可为空"}]}'`,
    '可一次提交多个 questions；UI 会在 Task 详情页逐条展示并让用户回答。',
    '',
    '只处理当前 delegation。不要处理其他 Task、其他 Story 或其他 agent 的工作。',
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
    await appendLoopRunLog(leaseId, `[运行] 下一轮发现 ${dispatch.delegations.length} 个 agent，启动逐个执行 runner`);
    await startCursorAgentRun(leaseId);
    return;
  }
  await startDispatchRetryRun(leaseId);
}

async function runDelegation(delegation: DelegationEnvelope) {
  const prompt = buildPrompt(delegation);
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

  await appendLoopRunLog(leaseId, `[Agent] 开始 agent=${delegation.agent} task=${delegation.taskId} story=${delegation.storyIndex ?? '-'} pipeline=${delegation.pipeline} - ${delegation.description}`);
  await appendLoopRunLog(leaseId, `[Cursor] 启动 ${delegation.agent}：${cursorBin} agent --print --output-format stream-json --force --workspace ${paths.root}`);

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
    for (const line of lines.filter(Boolean)) enqueueLog(logCursorJsonLine(line, delegation));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    lastOutputAt = Date.now();
    stderrBuffer += chunk.toString('utf8');
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) enqueueLog(logCursorStderrLine(line, delegation));
  });

  const terminate = async (reason: string) => {
    if (timedOut) return;
    timedOut = true;
    await appendLoopRunLog(leaseId, `[Cursor] ${reason}，正在终止 ${delegation.agent}`);
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
  if (stdoutBuffer.trim()) enqueueLog(logCursorJsonLine(stdoutBuffer, delegation));
  if (stderrBuffer.trim()) enqueueLog(logCursorStderrLine(stderrBuffer, delegation));
  await flushLogs();
  await appendLoopRunLog(leaseId, `[Cursor] ${delegation.agent} 已退出 code=${exitCode ?? 'signal'}`);
  if (exitCode && exitCode !== 0) await appendLoopRunLog(leaseId, `[错误] ${delegation.agent} 执行失败 code=${exitCode}`);
  else await appendLoopRunLog(leaseId, `[Agent] 完成 agent=${delegation.agent} task=${delegation.taskId} story=${delegation.storyIndex ?? '-'} pipeline=${delegation.pipeline} - 处理完成`);
  return exitCode ?? 1;
}

async function main() {
  const dispatch = await createLoopDispatch(leaseId, { includeRunHeader: false, logDelegations: false });
  if (!dispatch.delegations.length) {
    await startDispatchRetryRun(leaseId);
    return;
  }
  await appendLoopRunLog(leaseId, `[运行] 外部 runner 将逐个执行 ${dispatch.delegations.length} 个 agent`);
  for (const [index, delegation] of dispatch.delegations.entries()) {
    if (!(await isLeaseActive())) return;
    await appendLoopRunLog(leaseId, `[运行] 执行第 ${index + 1}/${dispatch.delegations.length} 个 agent：${delegation.agent}`);
    const exitCode = await runDelegation(delegation);
    if (exitCode !== 0) break;
  }
  await scheduleNextLoop();
}

main().catch(async (error) => {
  await appendLoopRunLog(leaseId, `[Cursor错误] ${error instanceof Error ? error.message : String(error)}`);
  await endRun(leaseId, true, { stopRunner: false });
});
