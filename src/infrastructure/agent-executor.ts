import type { AgentExecutorId } from '../domain/agent-executor';

export type AgentExecutionContext = {
  agent: string;
  taskId: string;
  storyIndex: number | null;
  pipeline: string;
  lane?: 'control' | 'analysis' | 'delivery';
};

export type AgentExecutionOptions = {
  /** 项目级 OMP slash command；工作包作为一个完整参数交给原生解析器。 */
  nativeCommand?: { name: string; path: string; sourceHash: string };
  model?: string;
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  systemPromptFile?: string;
  systemPromptText?: string;
  tools?: string[];
  skills?: string[];
  sessionDirectory?: string;
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
  env?: AgentEnvironment;
  promptMode: 'argument' | 'stdin';
  transport?: 'omp-rpc';
  buildArgs(prompt: string, workspaceRoot: string, options?: AgentExecutionOptions): string[];
  formatCommand(workspaceRoot: string, options?: AgentExecutionOptions): string;
  parseStdout(line: string, context: AgentExecutionContext): string | null;
  parseStderr(line: string, context: AgentExecutionContext): string | null;
};


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

function finalTextCandidate(_executor: AgentExecutorId, line: string): FinalTextCandidate | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const text = ompAssistantText(event);
    return text ? { text, priority: event.type === 'message_end' ? 30 : 20 } : null;
  } catch { return null; }
}
export function extractAgentFinalText(executor: AgentExecutorId, line: string) {
  return finalTextCandidate(executor,line)?.text ?? null;
}

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

export function extractAgentFailureDetail(_executor: AgentExecutorId, line: string) {
  try {
    const event=JSON.parse(line) as Record<string, unknown>;
    // A rejected tool call is recoverable work, not a provider/process failure.
    // Never use an aggregate assistant message or transcript as a fatal error.
    if (event.type === 'tool_execution_end') return null;
    if(event.type==='error' || event.is_error===true || event.isError===true || event.type==='agent_end' && event.error) {
      const error = event.error ?? (typeof event.message === 'string' ? event.message : undefined);
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object') {
        const detail = error as Record<string, unknown>;
        const fields = Object.fromEntries(['code', 'type', 'status', 'message'].flatMap(key =>
          typeof detail[key] === 'string' || typeof detail[key] === 'number' ? [[key, detail[key]]] : []));
        return Object.keys(fields).length ? JSON.stringify(fields) : null;
      }
    }
    return null;
  } catch { return null; }
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

function isAgentDomainCommand(command: string) {
  const normalized = command.replace(/\\(["'])/g, '$1');
  return /(?:^|[/\\])loop-agent\.mjs(?:["']|\s)/.test(normalized);
}

function summarizeCommand(command: string) {
  if (!command) return '';
  const normalized = command.replace(/\\(["'])/g, '$1').replace(/["']/g, '').replace('loop-agent.cjs ', 'loop-agent.mjs ');
  if (isAgentDomainCommand(command)) {
    if (normalized.includes('loop-agent.mjs status')) return '恢复命令链草稿';
    if (normalized.includes('loop-agent.mjs delivery-unit current')) return '读取当前交付单元';
    if (normalized.includes('loop-agent.mjs delivery-spec current')) return '读取冻结交付规格';
    if (normalized.includes('loop-agent.mjs schema show')) return '读取交付物 Schema';
    if (normalized.includes('loop-agent.mjs schema decision')) return '读取决策 Schema';
    if (normalized.includes('loop-agent.mjs artifact template')) return '读取交付物模板';
    if (normalized.includes('loop-agent.mjs decision template')) return '读取决策模板';
    if (normalized.includes('loop-agent.mjs acceptance put')) return '定义验收契约';
    if (normalized.includes('loop-agent.mjs acceptance remove')) return '移除验收契约';
    if (normalized.includes('loop-agent.mjs acceptance assess')) return '登记验收实现声明';
    if (normalized.includes('loop-agent.mjs artifact put')) return '登记交付物';
    if (normalized.includes('loop-agent.mjs artifact remove')) return '移除交付物';
    if (normalized.includes('loop-agent.mjs decision put')) return '登记决策';
    if (normalized.includes('loop-agent.mjs decision resolve')) return '关闭关键决策';
    if (normalized.includes('loop-agent.mjs decision ask')) return '请求用户决策';
    if (normalized.includes('loop-agent.mjs decision reopen')) return '重新打开关键决策';
    if (normalized.includes('loop-agent.mjs decision remove')) return '移除决策';
    if (normalized.includes('loop-agent.mjs check record')) return '登记真实命令检查';
    if (normalized.includes('loop-agent.mjs check remove')) return '移除命令检查';
    if (normalized.includes('loop-agent.mjs runtime-input put')) return '登记运行信息请求';
    if (normalized.includes('loop-agent.mjs runtime-input remove')) return '移除运行信息请求';
    if (normalized.includes('loop-agent.mjs metadata set')) return '设置需求 Metadata';
    if (normalized.includes('loop-agent.mjs metadata remove')) return '移除需求 Metadata';
    if (normalized.includes('loop-agent.mjs phase rewind')) return '回退命令链阶段';
    if (normalized.includes('loop-agent.mjs phase complete')) return '完成命令链阶段';
    if (normalized.includes(' evolution status')) return '恢复 执行经验草稿';
    if (normalized.includes(' evolution summary set')) return '保存演化摘要';
    if (normalized.includes(' evolution observation ')) return '更新可复用观察';
    if (normalized.includes(' evolution complete')) return '提交 执行经验结果';
    if (normalized.includes(' help')) return '查看当前 Agent 可用命令';
    return '更新 Agent 工作草稿';
  }
  if (command.includes(' agent-context ')) return '按需读取 execution Context Snapshot';
  if (command.includes(' task-context ')) return '读取数据库需求上下文';
  if (command.includes(' document-list ')) return '列出文档';
  if (command.includes(' document-get ')) return '读取文档';
  if (command.includes(' document-upsert ')) return '保存文档';
  if (command.includes(' story-add ')) return '新增交付单元';
  if (command.includes(' task-update ')) return '更新需求状态';
  if (command.includes('--help')) return '查看命令帮助';
  return compact(command);
}

function standardToolLog(executor: AgentExecutorId, context: AgentExecutionContext, tool: string, completed: boolean, detail: string) {
  return `[执行器工具] ${meta(executor, context)} tool=${tool || 'unknown'} - ${completed ? '完成' : '调用'}：${compact(detail || '执行工具')}`;
}

function standardOutputLog(executor: AgentExecutorId, context: AgentExecutionContext, detail: string) {
  return detail ? `[执行器输出] ${meta(executor, context)} - ${compact(detail)}` : null;
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

/** OMP can dispatch a registered tool through its native xd:// device as well. */
export function nativeWorkflowCommand(tool: unknown, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  let parameters = input as Record<string, unknown>;
  if (tool === 'write' && parameters.path === 'xd://loopwork' && typeof parameters.content === 'string') {
    try { parameters = JSON.parse(parameters.content); } catch { return null; }
  } else if (tool !== 'loopwork') return null;
  let args = parameters?.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!Array.isArray(args) || !args.length || !args.every(arg => typeof arg === 'string')) return null;
  return `loopwork ${args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`;
}

export function parseAgentTelemetryStdout(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  try {
    const event=JSON.parse(line) as Record<string, unknown>;

      const type = String(event.type || '');
      if (type === 'tool_execution_start' || type === 'tool_execution_end') {
        const completed = type === 'tool_execution_end';
        const tool = stringifyValue(event.toolName || event.tool || 'unknown');
        const args = event.args as Record<string, unknown> | undefined;
        // Native Workflow calls are domain commands, while retaining toolClass=other:
        // they must appear in audit without becoming successful Shell test receipts.
        const workflowCommand = nativeWorkflowCommand(tool, args);
        // Native browser runs are real validation operations, with their own
        // identity. Keep them distinct from Shell and Workflow submissions.
        const browserCommand = tool === 'browser' && args?.action === 'run'
          && typeof args.code === 'string' && args.code.trim()
          ? `browser run ${JSON.stringify(args)}` : null;
        const auditedCommand = workflowCommand || browserCommand;
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
            : auditedCommand ? compact(auditedCommand, 500) : summarizeCommand(stringifyValue(args?.command)) || compact(stringifyValue(event.args), 500),
          level: isError ? 'ERROR' : 'DEFAULT',
          ...(completed ? { success: !isError && (exitCode === null || exitCode === 0), exitCode } : {}),
          ...(completed ? { output: result ?? event.error } : { input: auditedCommand ? { ...args, command: auditedCommand } : event.args }),
        };
      }
      if (type === 'error') return telemetryDiagnostic(executor, stringifyValue(event.error || event.message || line));
      return null;

  } catch { return telemetryDiagnostic(executor,line,'DEFAULT'); }
}
export function parseAgentTelemetryStdoutEvents(executor: AgentExecutorId, line: string): AgentTelemetryEvent[] {
  const event=parseAgentTelemetryStdout(executor,line);
  return event ? [event] : [];
}

export function parseAgentTelemetryStderr(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  const text = compact(line, 500);
  if (!text) return null;

  const error = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const warning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  return telemetryDiagnostic(executor, text, error ? 'ERROR' : warning ? 'WARNING' : 'DEFAULT');
}

function stderrLog(executor: AgentExecutorId, context: AgentExecutionContext, line: string) {
  const text = compact(line);
  if (!text) return null;

  const isError = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const isWarning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  const label = isError ? '执行器错误' : isWarning ? '执行器警告' : '执行器诊断';
  return `[${label}] ${meta(executor, context)} - ${text}`;
}

const ompExecutor: AgentExecutor = {
    id: 'omp', label: 'Oh My Pi', command: process.env.OMP_CLI || 'omp', promptMode: 'stdin', transport: 'omp-rpc',
    buildArgs: (_prompt, _workspace, options) => [
      '--approval-mode', 'yolo',
      ...(options?.model ? ['--model', options.model] : []),
      ...(options?.reasoningEffort ? ['--thinking', options.reasoningEffort] : []),
      ...(options?.systemPromptFile ? ['--append-system-prompt', options.systemPromptFile] : []),
      ...(options?.tools ? options.tools.length ? ['--tools', options.tools.join(',')] : ['--no-tools'] : []),
      ...(options?.skills?.length ? ['--skills', options.skills.join(',')] : []),
    ],
    formatCommand: (workspace, options) => [
      'omp --mode rpc --approval-mode yolo',
      options?.model ? `--model ${options.model}` : '',
      options?.reasoningEffort ? `--thinking ${options.reasoningEffort}` : '',
      options?.nativeCommand ? `command=/${options.nativeCommand.name}` : '',
      `(stdin cwd=${workspace})`,
    ].filter(Boolean).join(' '),
    parseStdout: parseOmpStdout,
    parseStderr: (line, context) => stderrLog('omp', context, line),
  };

export function getAgentExecutor(id: AgentExecutorId): AgentExecutor {
  if(id !== 'omp') throw new Error('DJI 仅支持 OMP Runtime');
  return ompExecutor;
}
