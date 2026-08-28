import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, win32 } from 'node:path';
import type { AgentExecutorId } from '../domain/agent-executor';

export type AgentExecutionContext = {
  agent: string;
  taskId: string;
  storyIndex: number | null;
  pipeline: string;
  lane?: 'control' | 'analysis' | 'delivery';
};

export type AgentExecutionOptions = {
  model?: string;
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  webSearch?: boolean;
};

export type AgentRunMetrics = {
  model?: string;
  usage?: Record<string, unknown>;
  totalCostUsd?: number;
  durationMs?: number;
};

export type AgentEnvironment = Record<string, string | undefined>;

export type AgentToolClass = 'shell' | 'other' | 'unknown';

export type AgentTelemetryEvent = {
  name: 'loop.agent.tool' | 'loop.agent.output' | 'loop.agent.diagnostic';
  phase?: 'started' | 'completed';
  executor: AgentExecutorId;
  tool?: string;
  toolClass?: AgentToolClass;
  toolCallId?: string;
  sequence?: number;
  summary?: string;
  input?: unknown;
  output?: unknown;
  success?: boolean;
  exitCode?: number | null;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
};

export type AgentExecutor = {
  id: AgentExecutorId;
  label: string;
  command: string;
  prefixArgs?: string[];
  env?: AgentEnvironment;
  promptMode: 'argument' | 'stdin' | 'file-reference';
  buildArgs(prompt: string, workspaceRoot: string, options?: AgentExecutionOptions): string[];
  formatCommand(workspaceRoot: string, options?: AgentExecutionOptions): string;
  parseStdout(line: string, context: AgentExecutionContext): string | null;
  parseStderr(line: string, context: AgentExecutionContext): string | null;
};

type CursorLaunchOptions = {
  platform?: NodeJS.Platform;
  env?: AgentEnvironment;
  home?: string;
};

export type CursorAgentLaunch = {
  command: string;
  prefixArgs: string[];
  env: AgentEnvironment;
  viaBundledNode: boolean;
};

function cursorVersionRootCandidates(env: AgentEnvironment, home: string) {
  const roots = [
    env.CURSOR_AGENT_HOME ? join(env.CURSOR_AGENT_HOME, 'versions') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'cursor-agent', 'versions') : '',
    env.APPDATA ? join(env.APPDATA, 'cursor-agent', 'versions') : '',
    join(home, '.local', 'share', 'cursor-agent', 'versions'),
  ];
  const configuredCli = env.CURSOR_CLI;
  if (configuredCli && /[\\/]/.test(configuredCli)) {
    roots.unshift(resolve(dirname(configuredCli), '..', 'share', 'cursor-agent', 'versions'));
  }
  return [...new Set(roots.filter(Boolean))];
}

function latestCursorBundle(roots: string[]) {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let versions: string[] = [];
    try { versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { continue; }
    for (const version of versions) {
      const directory = join(root, version);
      const node = join(directory, 'node.exe');
      const script = join(directory, 'index.js');
      if (existsSync(node) && existsSync(script)) return { node, script };
    }
  }
  return null;
}

/** Bypasses cursor-agent.cmd on Windows so long prompts do not hit cmd.exe's 8191 character limit. */
export function resolveCursorAgentLaunch(options: CursorLaunchOptions = {}): CursorAgentLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32') {
    return { command: env.CURSOR_CLI || 'cursor-agent', prefixArgs: [], env: {}, viaBundledNode: false };
  }

  const overrideNode = env.CURSOR_AGENT_NODE?.trim();
  const overrideScript = env.CURSOR_AGENT_SCRIPT?.trim();
  if (Boolean(overrideNode) !== Boolean(overrideScript)) {
    throw new Error('Windows Cursor Agent 直启配置不完整：CURSOR_AGENT_NODE 与 CURSOR_AGENT_SCRIPT 必须同时设置');
  }
  const bundle = overrideNode && overrideScript
    ? { node: overrideNode, script: overrideScript }
    : latestCursorBundle(cursorVersionRootCandidates(env, options.home ?? homedir()));
  if (!bundle || !existsSync(bundle.node) || !existsSync(bundle.script)) {
    const configured = env.CURSOR_CLI;
    if (configured && !['.cmd', '.bat', '.ps1'].includes(extname(configured).toLowerCase())) {
      return { command: configured, prefixArgs: [], env: {}, viaBundledNode: false };
    }
    throw new Error('Windows 无法定位 Cursor Agent bundled Node；请设置 CURSOR_AGENT_NODE 与 CURSOR_AGENT_SCRIPT');
  }
  const cacheRoot = env.LOCALAPPDATA || env.TEMP || dirname(bundle.node);
  const cacheDirectory = platform === 'win32' ? win32.join(cacheRoot, 'cursor-compile-cache') : join(cacheRoot, 'cursor-compile-cache');
  return {
    command: bundle.node,
    prefixArgs: [bundle.script],
    env: {
      CURSOR_INVOKED_AS: 'cursor-agent',
      NODE_COMPILE_CACHE: env.NODE_COMPILE_CACHE || cacheDirectory,
    },
    viaBundledNode: true,
  };
}

/** Returns provider-neutral final assistant text when a stream record contains it. */
export function extractAgentFinalText(executor: AgentExecutorId, line: string) {
  return finalTextCandidate(executor, line)?.text ?? null;
}

type FinalTextCandidate = { text: string; priority: number };

function textFromContentBlocks(content: unknown) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => (item as Record<string, unknown>).type === 'text')
    .map((item) => stringifyValue((item as Record<string, unknown>).text))
    .join('');
}

function ompAssistantText(event: Record<string, unknown>) {
  if (event.type === 'message_end') {
    const message = event.message as Record<string, unknown> | undefined;
    return message?.role === 'assistant' ? textFromContentBlocks(message.content) : '';
  }
  if (event.type !== 'agent_end' || !Array.isArray(event.messages)) return '';
  const message = [...event.messages].reverse().find((item) => (item as Record<string, unknown>).role === 'assistant') as Record<string, unknown> | undefined;
  return textFromContentBlocks(message?.content);
}

function finalTextCandidate(executor: AgentExecutorId, line: string): FinalTextCandidate | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (executor === 'codex') {
      const item = event.item as Record<string, unknown> | undefined;
      const text = event.type === 'item.completed' && item?.type === 'agent_message' ? stringifyValue(item.text) : '';
      return text ? { text, priority: 30 } : null;
    }
    if (executor === 'claude') {
      if (event.type === 'result' && !event.is_error) {
        const text = stringifyValue(event.result);
        return text ? { text, priority: 30 } : null;
      }
      if (event.type !== 'assistant') return null;
      const text = claudeContentBlocks(event).filter((block) => block.type === 'text').map((block) => stringifyValue(block.text)).join('');
      return text ? { text, priority: 10 } : null;
    }
    if (executor === 'omp') {
      const text = ompAssistantText(event);
      return text ? { text, priority: event.type === 'message_end' ? 30 : 20 } : null;
    }
    if (event.type === 'assistant') {
      const content = (event.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) {
        const text = stringifyValue(event.text);
        return text ? { text, priority: 30 } : null;
      }
      const text = content
        .filter((item) => (item as Record<string, unknown>).type === 'text')
        .map((item) => stringifyValue((item as Record<string, unknown>).text))
        .join('');
      return text ? { text, priority: 30 } : null;
    }
    if (event.type === 'result' || event.subtype === 'result' || event.subtype === 'success') {
      const text = stringifyValue(event.result || event.text || event.message);
      // Cursor's aggregate result can repeat every earlier assistant message. Prefer the
      // last complete assistant message when both are present.
      return text ? { text, priority: 20 } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Keeps the best complete provider message without treating JSONL deltas as messages. */
export function createAgentFinalTextAccumulator(executor: AgentExecutorId) {
  let selected: FinalTextCandidate | null = null;
  return {
    ingest(line: string) {
      const candidate = finalTextCandidate(executor, line);
      if (candidate && (!selected || candidate.priority >= selected.priority)) selected = candidate;
    },
    value() { return selected?.text ?? ''; },
  };
}

/** Collects aggregate CLI metrics without pretending they are one model generation. */
export function createAgentRunMetricsAccumulator(executor: AgentExecutorId) {
  let metrics: AgentRunMetrics = {};
  return {
    ingest(line: string) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const usage = event.usage;
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) metrics.usage = usage as Record<string, unknown>;
        const model = stringifyValue(event.model || event.model_name || event.modelName);
        if (model) metrics.model = model;
        const cost = event.total_cost_usd ?? event.totalCostUsd;
        if (typeof cost === 'number' && Number.isFinite(cost)) metrics.totalCostUsd = cost;
        const duration = event.duration_ms ?? event.durationMs;
        if (typeof duration === 'number' && Number.isFinite(duration)) metrics.durationMs = duration;

        if (executor === 'omp' && event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined;
          const messageUsage = message?.usage;
          if (messageUsage && typeof messageUsage === 'object' && !Array.isArray(messageUsage)) {
            metrics.usage = messageUsage as Record<string, unknown>;
          }
          const messageModel = stringifyValue(message?.model || message?.modelId);
          if (messageModel) metrics.model = messageModel;
        }

        if (executor === 'claude' && event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage)) {
          const modelUsage = event.modelUsage as Record<string, unknown>;
          const models = Object.keys(modelUsage);
          if (!metrics.model && models.length === 1) metrics.model = models[0];
          metrics.usage = metrics.usage ?? { modelUsage };
        }
      } catch {
        // Malformed provider output is handled as a diagnostic by the telemetry parser.
      }
    },
    value(): AgentRunMetrics { return { ...metrics }; },
  };
}

function compact(value: string, limit = 1600) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stringifyValue(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Extracts provider-declared CLI failures that are transported in JSONL stdout. */
export function extractAgentFailureDetail(executor: AgentExecutorId, line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || '').toLowerCase();
    const subtype = String(event.subtype || '').toLowerCase();
    if (executor === 'claude' && (event.is_error === true || (type === 'result' && subtype.startsWith('error')))) {
      return stringifyValue(event.error || event.result || event.errors || event.message || line);
    }
    if (executor === 'codex' && (type === 'error' || type === 'turn.failed')) {
      return stringifyValue(event.message || event.error || line);
    }
    if (executor === 'omp' && (type === 'error' || event.is_error === true || event.isError === true || type === 'agent_end' && (event.error || event.message))) {
      return stringifyValue(event.error || event.message || event.result || line);
    }
    if (executor === 'cursor' && (type === 'error' || event.is_error === true)) {
      return stringifyValue(event.error || event.message || event.result || line);
    }
    return null;
  } catch {
    return null;
  }
}

function classifyAgentTool(tool: string): AgentToolClass {
  const normalized = tool.trim().toLowerCase();
  return normalized === 'shell' || normalized === 'bash' ? 'shell' : normalized ? 'other' : 'unknown';
}

function numericExitCode(...values: unknown[]) {
  const value = values.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
  return typeof value === 'number' ? value : null;
}

function meta(executor: AgentExecutorId, context: AgentExecutionContext) {
  return `executor=${executor} lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline}`;
}

function toolNameFromCursor(event: Record<string, unknown>) {
  const toolCall = event.tool_call as Record<string, unknown> | undefined;
  const key = toolCall ? Object.keys(toolCall).find((item) => item.endsWith('ToolCall')) : undefined;
  const payload = key ? toolCall?.[key] as Record<string, unknown> | undefined : undefined;
  return {
    tool: key ? key.replace(/ToolCall$/, '') : stringifyValue(event.tool || event.name || 'unknown'),
    toolCallId: stringifyValue(event.call_id || event.callId || payload?.id || (payload?.args as Record<string, unknown> | undefined)?.toolCallId),
    args: payload?.args as Record<string, unknown> | undefined,
    result: payload?.result as Record<string, unknown> | undefined,
  };
}

function isAgentDomainCommand(command: string) {
  const normalized = command.replace(/\\(["'])/g, '$1');
  return /(?:^|[/\\])loop-agent\.mjs(?:["']|\s)/.test(normalized);
}

function summarizeCommand(command: string) {
  if (!command) return '';
  const normalized = command.replace(/["']/g, '');
  if (isAgentDomainCommand(command)) {
    if (normalized.includes(' idea-context status')) return '恢复需求意图草稿';
    if (normalized.includes(' idea-context request-clarification')) return '提交需求意图确认问题';
    if (normalized.includes(' idea-context complete')) return '完成需求意图确认';
    if (normalized.includes(' idea-context ')) return '提交需求意图工作包';
    if (normalized.includes(' business-design status')) return '恢复业务方案草稿';
    if (normalized.includes(' business-design request-clarification')) return '提交业务方案决策';
    if (normalized.includes(' business-design complete')) return '完成业务方案设计';
    if (normalized.includes(' business-design ')) return '提交业务方案工作包';
    if (normalized.includes(' requirement-spec status')) return '恢复需求规格草稿';
    if (normalized.includes(' requirement-spec return-gap')) return '回流需求规格上游缺口';
    if (normalized.includes(' requirement-spec complete')) return '完成需求规格说明书';
    if (normalized.includes(' requirement-spec ')) return '提交需求规格工作包';
    if (normalized.includes(' spec-review status')) return '恢复规格审查草稿';
    if (normalized.includes(' spec-review approve')) return '批准需求规格说明书';
    if (normalized.includes(' spec-review return-revision')) return '回流规格审查缺口';
    if (normalized.includes(' spec-review ')) return '提交规格审查工作包';
    if (normalized.includes(' requirement-context status')) return '恢复需求上下文草稿';
    if (normalized.includes(' requirement-context intent set')) return '保存业务意图';
    if (normalized.includes(' requirement-context change set')) return '保存业务变化';
    if (normalized.includes(' requirement-context assertion ')) return '更新业务语义';
    if (normalized.includes(' requirement-context impact ')) return '更新业务影响';
    if (normalized.includes(' requirement-context acceptance ')) return '更新验收语义';
    if (normalized.includes(' requirement-context classification set')) return '保存需求分类';
    if (normalized.includes(' requirement-context constraint ')) return '更新需求约束';
    if (normalized.includes(' requirement-context scope ')) return '更新范围边界';
    if (normalized.includes(' requirement-context question ')) return '更新澄清问题';
    if (normalized.includes(' requirement-context validate')) return '校验需求上下文草稿';
    if (normalized.includes(' requirement-context request-clarification')) return '提交澄清请求';
    if (normalized.includes(' requirement-context complete')) return '完成需求上下文';
    if (normalized.includes(' delivery-plan status')) return '恢复交付计划草稿';
    if (normalized.includes(' delivery-plan rationale set')) return '保存交付拆分依据';
    if (normalized.includes(' delivery-plan coverage set')) return '保存交付覆盖说明';
    if (normalized.includes(' delivery-plan ordering set')) return '保存交付排序说明';
    if (normalized.includes(' delivery-plan unit upsert')) return '保存交付单元';
    if (normalized.includes(' delivery-plan unit dismiss')) return '排除候选交付单元';
    if (normalized.includes(' delivery-plan unit supersede')) return '取代候选交付单元';
    if (normalized.includes(' delivery-plan unit move')) return '调整交付单元顺序';
    if (normalized.includes(' delivery-plan unit source add')) return '关联交付规划输入';
    if (normalized.includes(' delivery-plan unit source remove')) return '移除交付规划输入关联';
    if (normalized.includes(' delivery-plan unit dependency add')) return '保存交付单元依赖';
    if (normalized.includes(' delivery-plan unit dependency remove')) return '移除交付单元依赖';
    if (normalized.includes(' delivery-plan validate')) return '校验交付计划草稿';
    if (normalized.includes(' delivery-plan complete')) return '完成交付计划';
    if (normalized.includes(' reproduction status')) return '恢复问题复现草稿';
    if (normalized.includes(' reproduction expected set')) return '保存预期行为';
    if (normalized.includes(' reproduction actual set')) return '保存实际行为';
    if (normalized.includes(' reproduction environment set')) return '保存复现环境';
    if (normalized.includes(' reproduction stability set')) return '保存稳定性与对照结论';
    if (normalized.includes(' reproduction impact set')) return '保存最小影响范围';
    if (normalized.includes(' reproduction step ')) return '更新复现步骤';
    if (normalized.includes(' reproduction evidence ')) return '更新复现证据';
    if (normalized.includes(' reproduction hypothesis ')) return '更新根因假设';
    if (normalized.includes(' reproduction question ')) return '更新人工对齐问题';
    if (normalized.includes(' reproduction validate')) return '校验问题复现草稿';
    if (normalized.includes(' reproduction request-alignment')) return '提交人工对齐请求';
    if (normalized.includes(' reproduction complete')) return '完成问题复现';
    if (normalized.includes(' delivery-analysis status')) return '恢复交付分析草稿';
    if (normalized.includes(' delivery-analysis summary set')) return '保存交付分析结论';
    if (normalized.includes(' delivery-analysis contract set')) return '保存冻结交付契约';
    if (normalized.includes(' delivery-analysis impact ')) return '更新实际影响';
    if (normalized.includes(' delivery-analysis decision option-')) return '更新决策选项';
    if (normalized.includes(' delivery-analysis decision ask')) return '提交决策建议';
    if (normalized.includes(' delivery-analysis decision resolve')) return '关闭关键决策';
    if (normalized.includes(' delivery-analysis decision reopen')) return '重新打开关键决策';
    if (normalized.includes(' delivery-analysis decision ')) return '更新关键决策';
    if (normalized.includes(' delivery-analysis guardrail ')) return '更新保护约束';
    if (normalized.includes(' delivery-analysis verification-focus ')) return '更新验证关注点';
    if (normalized.includes(' delivery-analysis validate')) return '校验交付分析草稿';
    if (normalized.includes(' delivery-analysis request-clarification')) return '提交关键决策问题';
    if (normalized.includes(' delivery-analysis complete')) return '完成交付分析';
    if (normalized.includes(' implementation status')) return '恢复开发实现草稿';
    if (normalized.includes(' implementation criterion ')) return '更新验收覆盖';
    if (normalized.includes(' implementation check ')) return '选择关键检查';
    if (normalized.includes(' implementation risk ')) return '更新残余风险';
    if (normalized.includes(' implementation runtime-input ')) return '更新运行信息请求';
    if (normalized.includes(' implementation recovery ')) return '更新恢复事项';
    if (normalized.includes(' implementation commit complete')) return '确认代码提交步骤';
    if (normalized.includes(' implementation commit reopen-verification')) return '返回开发者验证';
    if (normalized.includes(' implementation validate')) return '校验开发实现草稿';
    if (normalized.includes(' implementation request-input')) return '提交运行信息请求';
    if (normalized.includes(' implementation complete')) return '完成开发实现';
    if (normalized.includes(' implementation fail')) return '提交开发失败';
    if (normalized.includes(' verification status')) return '恢复验证草稿';
    if (normalized.includes(' verification plan complete')) return '完成测试计划';
    if (normalized.includes(' verification plan dismiss')) return '撤销测试计划项';
    if (normalized.includes(' verification plan upsert')) return '更新测试计划';
    if (normalized.includes(' verification result record')) return '记录场景验证结果';
    if (normalized.includes(' verification execute complete')) return '完成测试执行';
    if (normalized.includes(' verification evidence-review record')) return '记录验证证据复核';
    if (normalized.includes(' verification evidence-review complete')) return '完成验证证据复核';
    if (normalized.includes(' verification evidence-review reopen-execution')) return '回流验证执行';
    if (normalized.includes(' verification finalize reopen-evidence-review')) return '回流验证证据复核';
    if (normalized.includes(' verification validate')) return '校验验证草稿';
    if (normalized.includes(' verification request-input')) return '提交验证运行信息请求';
    if (normalized.includes(' verification complete')) return '提交验证结论';
    if (normalized.includes(' feedback status')) return '恢复反馈草稿';
    if (normalized.includes(' feedback summary set')) return '保存反馈处理摘要';
    if (normalized.includes(' feedback group ')) return '更新反馈工作组';
    if (normalized.includes(' feedback question ')) return '更新反馈澄清问题';
    if (normalized.includes(' feedback verification reason set')) return '保存反馈验证理由';
    if (normalized.includes(' feedback evidence ')) return '更新反馈验证证据';
    if (normalized.includes(' feedback triage-complete')) return '提交反馈批次分流';
    if (normalized.includes(' feedback request-clarification')) return '提交反馈澄清问题';
    if (normalized.includes(' feedback resolve')) return '提交反馈已满足';
    if (normalized.includes(' feedback reopen')) return '提交反馈重新处理';
    if (normalized.includes(' review status')) return '恢复最终事实对账草稿';
    if (normalized.includes(' review reconciliation upsert')) return '保存最终事实对账';
    if (normalized.includes(' review reconciliation complete')) return '完成最终事实对账';
    if (normalized.includes(' review assessment record')) return '保存需求级结卡评估';
    if (normalized.includes(' review assessment complete')) return '完成需求级结卡评估';
    if (normalized.includes(' review forward-unit ')) return '更新结卡缺口交付单元';
    if (normalized.includes(' review forward-units complete')) return '完成结卡缺口交付单元';
    if (normalized.includes(' review report complete')) return '完成结卡报告';
    if (normalized.includes(' review validate')) return '校验结卡草稿';
    if (normalized.includes(' review reconciliation dismiss')) return '撤销最终事实对账';
    if (normalized.includes(' review gap upsert')) return '记录结卡缺口';
    if (normalized.includes(' review gap resolve')) return '解决结卡缺口';
    if (normalized.includes(' review report section-upsert')) return '更新结卡报告章节';
    if (normalized.includes(' review complete')) return '提交最终事实对账';
    if (normalized.includes(' evolution status')) return '恢复 Prompt 演化草稿';
    if (normalized.includes(' evolution summary set')) return '保存演化摘要';
    if (normalized.includes(' evolution observation ')) return '更新可复用观察';
    if (normalized.includes(' evolution complete')) return '提交 Prompt 演化结果';
    if (normalized.includes(' help')) return '查看当前 Agent 可用命令';
    return '更新 Agent 工作草稿';
  }
  if (command.includes(' agent-context ')) return '按需读取 execution Context Snapshot';
  if (command.includes(' task-context ')) return '读取数据库需求上下文';
  if (command.includes(' document-list ')) return '列出数据库文档';
  if (command.includes(' document-get ')) return '读取数据库文档';
  if (command.includes(' document-upsert ')) return '保存数据库文档';
  if (command.includes(' story-add ')) return '新增交付单元';
  if (command.includes(' task-update ')) return '更新需求状态';
  if (command.includes('--help')) return '查看命令帮助';
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
  const files = Array.isArray(success.files) ? `匹配 ${success.files.length} 个文件` : '';
  const summary = stdout ? `输出 ${stdout.split(/\r?\n/).filter(Boolean).length} 行` : files || '成功';
  return [exitCode, summary].filter(Boolean).join('，');
}

function standardToolLog(executor: AgentExecutorId, context: AgentExecutionContext, tool: string, completed: boolean, detail: string) {
  return `[执行器工具] ${meta(executor, context)} tool=${tool || 'unknown'} - ${completed ? '完成' : '调用'}：${compact(detail || '执行工具')}`;
}

function standardOutputLog(executor: AgentExecutorId, context: AgentExecutionContext, detail: string) {
  return detail ? `[执行器输出] ${meta(executor, context)} - ${compact(detail)}` : null;
}

function standardEventLog(executor: AgentExecutorId, context: AgentExecutionContext, detail: string) {
  return `[执行器事件] ${meta(executor, context)} - ${compact(detail)}`;
}

function parseCursorStdout(line: string, context: AgentExecutionContext) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || 'event');
    const subtype = String(event.subtype || '');
    const { tool, args, result } = toolNameFromCursor(event);
    if (type === 'tool_call' || event.tool_call) {
      const completed = subtype === 'completed';
      const command = stringifyValue(args?.command);
      const normalizedTool = isAgentDomainCommand(command) ? 'agent-command' : tool;
      const detail = completed
        ? summarizeResult(result)
        : stringifyValue(args?.description) || summarizeCommand(command) || stringifyValue(args?.path || args?.targetDirectory);
      return standardToolLog('cursor', context, normalizedTool, completed, detail);
    }
    if (type === 'user' || type === 'system') return null;
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    const text = Array.isArray(content)
      ? content.map((item) => stringifyValue((item as Record<string, unknown>).text)).filter(Boolean).join('')
      : stringifyValue(event.text || event.message || event.delta || event.content || event.result);
    return standardOutputLog('cursor', context, text) || standardEventLog('cursor', context, line);
  } catch {
    return standardOutputLog('cursor', context, line);
  }
}

function parseCodexStdout(line: string, context: AgentExecutionContext) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || 'event');
    const item = event.item as Record<string, unknown> | undefined;
    const itemType = String(item?.type || '');
    if ((type === 'item.started' || type === 'item.completed') && item) {
      if (itemType === 'command_execution') {
        const completed = type === 'item.completed';
        const command = stringifyValue(item.command);
        const tool = isAgentDomainCommand(command)
          ? 'agent-command'
          : 'shell';
        const detail = completed
          ? [`exit=${stringifyValue(item.exit_code)}`, compact(stringifyValue(item.aggregated_output), 500)].filter(Boolean).join('，')
          : summarizeCommand(command);
        return standardToolLog('codex', context, tool, completed, detail);
      }
      if (itemType === 'mcp_tool_call' || itemType === 'file_change' || itemType === 'web_search') {
        const completed = type === 'item.completed';
        const tool = stringifyValue(item.name || itemType);
        return standardToolLog('codex', context, tool, completed, stringifyValue(item.arguments || item.changes || item.query || item.result));
      }
      if (itemType === 'agent_message' || itemType === 'reasoning') return standardOutputLog('codex', context, stringifyValue(item.text));
    }
    if (type === 'error' || type === 'turn.failed') return `[执行器错误] ${meta('codex', context)} - ${compact(stringifyValue(event.message || event.error || line))}`;
    return null;
  } catch {
    return standardOutputLog('codex', context, line);
  }
}

function claudeContentBlocks(event: Record<string, unknown>) {
  const message = event.message as Record<string, unknown> | undefined;
  return Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
}

function parseClaudeStdout(line: string, context: AgentExecutionContext) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || 'event');
    if (type === 'system') return null;
    if (type === 'assistant') {
      const blocks = claudeContentBlocks(event);
      const toolUse = blocks.find((block) => block.type === 'tool_use');
      if (toolUse) {
        const input = toolUse.input as Record<string, unknown> | undefined;
        const detail = stringifyValue(input?.description) || summarizeCommand(stringifyValue(input?.command)) || stringifyValue(toolUse.input);
        return standardToolLog('claude', context, stringifyValue(toolUse.name), false, detail);
      }
      return standardOutputLog('claude', context, blocks.map((block) => stringifyValue(block.text)).filter(Boolean).join(''));
    }
    if (type === 'user') {
      const toolResult = claudeContentBlocks(event).find((block) => block.type === 'tool_result');
      if (toolResult) return standardToolLog('claude', context, stringifyValue(toolResult.tool_use_id || 'tool'), true, stringifyValue(toolResult.content));
      return null;
    }
    if (type === 'result') {
      if (event.is_error) return `[执行器错误] ${meta('claude', context)} - ${compact(stringifyValue(event.result || event.error || line))}`;
      return null;
    }
    return null;
  } catch {
    return standardOutputLog('claude', context, line);
  }
}

function parseOmpStdout(line: string, context: AgentExecutionContext) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || 'event');
    if (type === 'tool_execution_start' || type === 'tool_execution_end') {
      const completed = type === 'tool_execution_end';
      const tool = stringifyValue(event.toolName || event.tool || 'unknown');
      const args = event.args as Record<string, unknown> | undefined;
      const command = stringifyValue(args?.command);
      const normalizedTool = isAgentDomainCommand(command) ? 'agent-command' : tool;
      const detail = completed
        ? stringifyValue(event.result || event.output || event.error)
        : stringifyValue(args?.description) || summarizeCommand(command) || stringifyValue(event.args);
      return standardToolLog('omp', context, normalizedTool, completed, detail);
    }
    if (type === 'message_end') {
      const text = ompAssistantText(event);
      return text ? standardOutputLog('omp', context, text) : null;
    }
    if (type === 'error' || event.is_error === true || event.isError === true || type === 'agent_end' && (event.error || event.message)) return `[执行器错误] ${meta('omp', context)} - ${compact(stringifyValue(event.error || event.message || event.result || line))}`;
    return null;
  } catch {
    return standardOutputLog('omp', context, line);
  }
}

function telemetryDiagnostic(executor: AgentExecutorId, summary: string, level: 'DEFAULT' | 'WARNING' | 'ERROR' = 'ERROR'): AgentTelemetryEvent {
  return { name: 'loop.agent.diagnostic', executor, summary: compact(summary, 500), level };
}

/** Converts a single CLI JSONL record into a small, provider-neutral telemetry event. */
export function parseAgentTelemetryStdout(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (executor === 'omp') {
      const type = String(event.type || '');
      if (type === 'tool_execution_start' || type === 'tool_execution_end') {
        const completed = type === 'tool_execution_end';
        const tool = stringifyValue(event.toolName || event.tool || 'unknown');
        const args = event.args as Record<string, unknown> | undefined;
        const result = event.result ?? event.output;
        const isError = event.isError === true || Boolean(event.error);
        const exitCode = completed
          ? numericExitCode(event.exitCode, (result as Record<string, unknown> | undefined)?.exitCode)
          : undefined;
        return {
          name: 'loop.agent.tool', executor, tool, toolClass: classifyAgentTool(tool),
          toolCallId: stringifyValue(event.toolCallId || event.callId || event.id) || undefined,
          phase: completed ? 'completed' : 'started',
          summary: completed
            ? compact(stringifyValue(result || event.error), 500)
            : summarizeCommand(stringifyValue(args?.command)) || compact(stringifyValue(event.args), 500),
          level: isError ? 'ERROR' : 'DEFAULT',
          ...(completed ? { success: !isError && (exitCode === null || exitCode === 0), exitCode } : {}),
          ...(completed ? { output: result ?? event.error } : { input: event.args }),
        };
      }
      if (type === 'error') return telemetryDiagnostic(executor, stringifyValue(event.error || event.message || line));
      return null;
    }
    if (executor === 'cursor') {
      const { tool, toolCallId, args, result } = toolNameFromCursor(event);
      if (String(event.type) === 'tool_call' || event.tool_call) {
        const completed = String(event.subtype) === 'completed';
        const successResult = result?.success;
        const successPayload = successResult && typeof successResult === 'object'
          ? successResult as Record<string, unknown>
          : undefined;
        const errorPayload = result?.error && typeof result.error === 'object'
          ? result.error as Record<string, unknown>
          : undefined;
        const exitCode = completed
          ? numericExitCode(result?.exitCode, successPayload?.exitCode, errorPayload?.exitCode)
          : undefined;
        const explicitSuccess = completed
          ? Boolean(successResult) && !result?.error && !result?.failure && (exitCode === null || exitCode === 0)
          : undefined;
        const failed = completed && (
          Boolean(result?.error || result?.failure)
          || (exitCode !== null && exitCode !== 0)
        );
        return {
          name: 'loop.agent.tool', executor, tool, toolCallId: toolCallId || undefined,
          toolClass: classifyAgentTool(tool),
          phase: completed ? 'completed' : 'started',
          summary: completed ? summarizeResult(result) : summarizeCommand(stringifyValue(args?.command)) || stringifyValue(args?.description),
          level: failed ? 'ERROR' : 'DEFAULT',
          ...(completed ? { success: explicitSuccess, exitCode } : {}),
          ...(completed ? { output: result } : { input: args }),
        };
      }
      if (event.type === 'user' || event.type === 'system') return null;
      if (event.type === 'error' || event.subtype === 'error') return telemetryDiagnostic(executor, stringifyValue(event.message || event.error || line));
      // Assistant chunks, deltas, reasoning and aggregate result records are coalesced by
      // createAgentFinalTextAccumulator and written once when the Agent span ends.
      return null;
    }
    if (executor === 'codex') {
      const type = String(event.type || '');
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = String(item?.type || '');
      if ((type === 'item.started' || type === 'item.completed') && item && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(itemType)) {
        const completed = type === 'item.completed';
        const tool = itemType === 'command_execution' ? 'shell' : stringifyValue(item.name || itemType);
        const toolClass = itemType === 'command_execution' ? 'shell' : classifyAgentTool(tool);
        const detail = itemType === 'command_execution' ? summarizeCommand(stringifyValue(item.command)) : stringifyValue(item.arguments || item.changes || item.query);
        const exitCode = completed ? numericExitCode(item.exit_code) : undefined;
        const status = stringifyValue(item.status).toLowerCase();
        const failed = completed && (status === 'failed' || (exitCode !== null && exitCode !== 0));
        const explicitSuccess = completed
          ? itemType === 'command_execution'
            ? exitCode === 0 && status !== 'failed'
            : status
              ? ['completed', 'success', 'succeeded'].includes(status)
              : !failed
          : undefined;
        return {
          name: 'loop.agent.tool', executor, tool, toolClass,
          toolCallId: stringifyValue(item.id || item.call_id || item.callId) || undefined,
          phase: completed ? 'completed' : 'started',
          summary: completed ? compact(stringifyValue(item.aggregated_output || item.result || item.exit_code), 500) : compact(detail, 500),
          level: failed ? 'ERROR' : 'DEFAULT',
          ...(completed ? { success: explicitSuccess, exitCode } : {}),
          ...(completed ? {
            output: {
              result: item.aggregated_output ?? item.result ?? '',
              exitCode: item.exit_code ?? null,
              status: item.status ?? null,
            },
          } : { input: item.arguments || item.command || item.changes || item.query }),
        };
      }
      if (type === 'error' || type === 'turn.failed') return telemetryDiagnostic(executor, stringifyValue(event.message || event.error || line));
      if (itemType === 'agent_message' || itemType === 'reasoning') return null;
      return null;
    }
    const type = String(event.type || '');
    if (type === 'assistant') {
      const blocks = claudeContentBlocks(event);
      const toolUse = blocks.find((block) => block.type === 'tool_use');
      if (toolUse) return {
        name: 'loop.agent.tool', executor, tool: stringifyValue(toolUse.name),
        toolClass: classifyAgentTool(stringifyValue(toolUse.name)),
        toolCallId: stringifyValue(toolUse.id) || undefined,
        phase: 'started', summary: summarizeCommand(stringifyValue((toolUse.input as Record<string, unknown> | undefined)?.command)), input: toolUse.input,
      };
      return null;
    }
    if (type === 'user') {
      const toolResult = claudeContentBlocks(event).find((block) => block.type === 'tool_result');
      if (toolResult) return {
        name: 'loop.agent.tool', executor, tool: 'tool', toolCallId: stringifyValue(toolResult.tool_use_id) || undefined,
        toolClass: 'unknown',
        phase: 'completed', summary: compact(stringifyValue(toolResult.content), 500), output: toolResult.content,
        success: toolResult.is_error !== true,
        exitCode: null,
        level: toolResult.is_error ? 'ERROR' : 'DEFAULT',
      };
    }
    if (type === 'result' && event.is_error) return telemetryDiagnostic(executor, stringifyValue(event.result || event.error || line));
    if (type === 'result') return null;
    return null;
  } catch {
    return telemetryDiagnostic(executor, line, 'DEFAULT');
  }
}

/** A Claude stream record may contain several parallel tool blocks. Preserve all of them. */
export function parseAgentTelemetryStdoutEvents(executor: AgentExecutorId, line: string): AgentTelemetryEvent[] {
  if (executor !== 'claude') {
    const event = parseAgentTelemetryStdout(executor, line);
    return event ? [event] : [];
  }
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const blocks = claudeContentBlocks(record);
    if (record.type === 'assistant') {
      const tools = blocks.filter((block) => block.type === 'tool_use');
      if (tools.length) return tools.map((toolUse) => ({
        name: 'loop.agent.tool', executor,
        tool: stringifyValue(toolUse.name),
        toolClass: classifyAgentTool(stringifyValue(toolUse.name)),
        toolCallId: stringifyValue(toolUse.id) || undefined,
        phase: 'started',
        summary: summarizeCommand(stringifyValue((toolUse.input as Record<string, unknown> | undefined)?.command)),
        input: toolUse.input,
      }));
    }
    if (record.type === 'user') {
      const results = blocks.filter((block) => block.type === 'tool_result');
      if (results.length) return results.map((toolResult) => ({
        name: 'loop.agent.tool', executor,
        tool: 'tool',
        toolClass: 'unknown',
        toolCallId: stringifyValue(toolResult.tool_use_id) || undefined,
        phase: 'completed',
        summary: compact(stringifyValue(toolResult.content), 500),
        output: toolResult.content,
        success: toolResult.is_error !== true,
        exitCode: null,
        level: toolResult.is_error ? 'ERROR' : 'DEFAULT',
      }));
    }
  } catch {
    // The provider-neutral fallback below records malformed stdout as a diagnostic.
  }
  const event = parseAgentTelemetryStdout(executor, line);
  return event ? [event] : [];
}

export function parseAgentTelemetryStderr(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  const text = compact(line, 500);
  if (!text) return null;
  if (executor === 'codex' && (
    /^Reading additional input from stdin\.\.\.$/.test(text)
    || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(text)
    || /codex_core_plugins::manifest: ignoring interface\.defaultPrompt: maximum of \d+ prompts is supported/.test(text)
  )) return null;
  const error = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const warning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  return telemetryDiagnostic(executor, text, error ? 'ERROR' : warning ? 'WARNING' : 'DEFAULT');
}

function stderrLog(executor: AgentExecutorId, context: AgentExecutionContext, line: string) {
  const text = compact(line);
  if (!text) return null;
  if (executor === 'codex' && (
    /^Reading additional input from stdin\.\.\.$/.test(text)
    || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(text)
    || /codex_core_plugins::manifest: ignoring interface\.defaultPrompt: maximum of \d+ prompts is supported/.test(text)
  )) return null;
  const isError = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const isWarning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  const label = isError ? '执行器错误' : isWarning ? '执行器警告' : '执行器诊断';
  return `[${label}] ${meta(executor, context)} - ${text}`;
}

const executors: Omit<Record<AgentExecutorId, AgentExecutor>, 'cursor'> = {
  codex: {
    id: 'codex', label: 'Codex', command: process.env.CODEX_CLI || 'codex', promptMode: 'stdin',
    buildArgs: (_prompt, workspace, options) => [
      ...(options?.webSearch ? ['--search'] : []),
      'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
      ...(options?.model ? ['--model', options.model] : []),
      ...(options?.reasoningEffort ? ['--config', `model_reasoning_effort="${options.reasoningEffort}"`] : []),
      '-C', workspace, '-',
    ],
    formatCommand: (workspace, options) => [
      `codex${options?.webSearch ? ' --search' : ''} exec --json`,
      options?.model ? `--model ${options.model}` : '',
      options?.reasoningEffort ? `--config model_reasoning_effort=${options.reasoningEffort}` : '',
      `-C ${workspace}`,
    ].filter(Boolean).join(' '),
    parseStdout: parseCodexStdout,
    parseStderr: (line, context) => stderrLog('codex', context, line),
  },
  claude: {
    id: 'claude', label: 'Claude', command: process.env.CLAUDE_CLI || 'claude', promptMode: 'stdin',
    buildArgs: (_prompt, _workspace, options) => ['--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence', ...(options?.model ? ['--model', options.model] : [])],
    formatCommand: (workspace, options) => `claude --print --input-format text --output-format stream-json${options?.model ? ` --model ${options.model}` : ''} (stdin cwd=${workspace})`,
    parseStdout: parseClaudeStdout,
    parseStderr: (line, context) => stderrLog('claude', context, line),
  },
  omp: {
    id: 'omp', label: 'Oh My Pi', command: process.env.OMP_CLI || 'omp', promptMode: 'stdin',
    buildArgs: (_prompt, _workspace, options) => [
      '--print', '--mode', 'json', '--no-session', '--approval-mode', 'yolo',
      ...(options?.model ? ['--model', options.model] : []),
      ...(options?.reasoningEffort ? ['--thinking', options.reasoningEffort] : []),
    ],
    formatCommand: (workspace, options) => [
      'omp --print --mode json --no-session --approval-mode yolo',
      options?.model ? `--model ${options.model}` : '',
      options?.reasoningEffort ? `--thinking ${options.reasoningEffort}` : '',
      `(stdin cwd=${workspace})`,
    ].filter(Boolean).join(' '),
    parseStdout: parseOmpStdout,
    parseStderr: (line, context) => stderrLog('omp', context, line),
  },
};

function cursorExecutor(): AgentExecutor {
  const launch = resolveCursorAgentLaunch();
  return {
    id: 'cursor', label: 'Cursor', command: launch.command, prefixArgs: launch.prefixArgs, env: launch.env, promptMode: 'file-reference',
    buildArgs: (prompt) => ['--print', '--output-format', 'stream-json', '--force', prompt],
    formatCommand: (workspace) => `cursor-agent --print --output-format stream-json --force (${launch.viaBundledNode ? 'via=node ' : ''}cwd=${workspace})`,
    parseStdout: parseCursorStdout,
    parseStderr: (line, context) => stderrLog('cursor', context, line),
  };
}

export function getAgentExecutor(id: AgentExecutorId) {
  return id === 'cursor' ? cursorExecutor() : executors[id];
}
