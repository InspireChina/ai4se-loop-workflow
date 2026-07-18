import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, win32 } from 'node:path';
import type { AgentExecutorId } from '../domain/agent-executor';

export type AgentExecutionContext = {
  agent: string;
  taskId: string;
  storyIndex: number | null;
  pipeline: string;
};

export type AgentExecutionOptions = {
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

export type AgentRunMetrics = {
  model?: string;
  usage?: Record<string, unknown>;
  totalCostUsd?: number;
  durationMs?: number;
};

export type AgentEnvironment = Record<string, string | undefined>;

export type AgentTelemetryEvent = {
  name: 'loop.agent.tool' | 'loop.agent.output' | 'loop.agent.diagnostic';
  phase?: 'started' | 'completed';
  executor: AgentExecutorId;
  tool?: string;
  toolCallId?: string;
  sequence?: number;
  summary?: string;
  input?: unknown;
  output?: unknown;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
};

export type AgentExecutor = {
  id: AgentExecutorId;
  label: string;
  command: string;
  prefixArgs?: string[];
  env?: AgentEnvironment;
  promptMode: 'argument' | 'stdin';
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

function meta(executor: AgentExecutorId, context: AgentExecutionContext) {
  return `executor=${executor} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline}`;
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

function summarizeCommand(command: string) {
  if (!command) return '';
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
      const detail = completed
        ? summarizeResult(result)
        : stringifyValue(args?.description) || summarizeCommand(stringifyValue(args?.command)) || stringifyValue(args?.path || args?.targetDirectory);
      return standardToolLog('cursor', context, tool, completed, detail);
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
        const detail = completed
          ? [`exit=${stringifyValue(item.exit_code)}`, compact(stringifyValue(item.aggregated_output), 500)].filter(Boolean).join('，')
          : summarizeCommand(command);
        return standardToolLog('codex', context, 'shell', completed, detail);
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
      return standardOutputLog('claude', context, stringifyValue(event.result));
    }
    return null;
  } catch {
    return standardOutputLog('claude', context, line);
  }
}

function telemetryDiagnostic(executor: AgentExecutorId, summary: string, level: 'DEFAULT' | 'WARNING' | 'ERROR' = 'ERROR'): AgentTelemetryEvent {
  return { name: 'loop.agent.diagnostic', executor, summary: compact(summary, 500), level };
}

/** Converts a single CLI JSONL record into a small, provider-neutral telemetry event. */
export function parseAgentTelemetryStdout(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (executor === 'cursor') {
      const { tool, toolCallId, args, result } = toolNameFromCursor(event);
      if (String(event.type) === 'tool_call' || event.tool_call) {
        const completed = String(event.subtype) === 'completed';
        return {
          name: 'loop.agent.tool', executor, tool, toolCallId: toolCallId || undefined,
          phase: completed ? 'completed' : 'started',
          summary: completed ? summarizeResult(result) : summarizeCommand(stringifyValue(args?.command)) || stringifyValue(args?.description),
          level: completed && result?.error ? 'ERROR' : 'DEFAULT',
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
        const detail = itemType === 'command_execution' ? summarizeCommand(stringifyValue(item.command)) : stringifyValue(item.arguments || item.changes || item.query);
        const failed = completed && (item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0));
        return {
          name: 'loop.agent.tool', executor, tool,
          toolCallId: stringifyValue(item.id || item.call_id || item.callId) || undefined,
          phase: completed ? 'completed' : 'started',
          summary: completed ? compact(stringifyValue(item.aggregated_output || item.result || item.exit_code), 500) : compact(detail, 500),
          level: failed ? 'ERROR' : 'DEFAULT',
          ...(completed ? { output: item.aggregated_output ?? item.result ?? item.exit_code } : { input: item.arguments || item.command || item.changes || item.query }),
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
        toolCallId: stringifyValue(toolUse.id) || undefined,
        phase: 'started', summary: summarizeCommand(stringifyValue((toolUse.input as Record<string, unknown> | undefined)?.command)), input: toolUse.input,
      };
      return null;
    }
    if (type === 'user') {
      const toolResult = claudeContentBlocks(event).find((block) => block.type === 'tool_result');
      if (toolResult) return {
        name: 'loop.agent.tool', executor, tool: 'tool', toolCallId: stringifyValue(toolResult.tool_use_id) || undefined,
        phase: 'completed', summary: compact(stringifyValue(toolResult.content), 500), output: toolResult.content,
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
        toolCallId: stringifyValue(toolResult.tool_use_id) || undefined,
        phase: 'completed',
        summary: compact(stringifyValue(toolResult.content), 500),
        output: toolResult.content,
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
  if (executor === 'codex' && (/^Reading additional input from stdin\.\.\.$/.test(text) || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(text))) return null;
  const error = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const warning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  return telemetryDiagnostic(executor, text, error ? 'ERROR' : warning ? 'WARNING' : 'DEFAULT');
}

function stderrLog(executor: AgentExecutorId, context: AgentExecutionContext, line: string) {
  const text = compact(line);
  if (!text) return null;
  if (executor === 'codex' && (/^Reading additional input from stdin\.\.\.$/.test(text) || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(text))) return null;
  const isError = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  const isWarning = /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(text);
  const label = isError ? '执行器错误' : isWarning ? '执行器警告' : '执行器诊断';
  return `[${label}] ${meta(executor, context)} - ${text}`;
}

const executors: Omit<Record<AgentExecutorId, AgentExecutor>, 'cursor'> = {
  codex: {
    id: 'codex', label: 'Codex', command: process.env.CODEX_CLI || 'codex', promptMode: 'stdin',
    buildArgs: (_prompt, workspace, options) => [
      'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
      ...(options?.model ? ['--model', options.model] : []),
      ...(options?.reasoningEffort ? ['--config', `model_reasoning_effort="${options.reasoningEffort}"`] : []),
      '-C', workspace, '-',
    ],
    formatCommand: (workspace, options) => [
      'codex exec --json',
      options?.model ? `--model ${options.model}` : '',
      options?.reasoningEffort ? `--config model_reasoning_effort=${options.reasoningEffort}` : '',
      `-C ${workspace}`,
    ].filter(Boolean).join(' '),
    parseStdout: parseCodexStdout,
    parseStderr: (line, context) => stderrLog('codex', context, line),
  },
  claude: {
    id: 'claude', label: 'Claude', command: process.env.CLAUDE_CLI || 'claude', promptMode: 'argument',
    buildArgs: (prompt) => ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence', prompt],
    formatCommand: (workspace) => `claude --print --output-format stream-json (cwd=${workspace})`,
    parseStdout: parseClaudeStdout,
    parseStderr: (line, context) => stderrLog('claude', context, line),
  },
};

function cursorExecutor(): AgentExecutor {
  const launch = resolveCursorAgentLaunch();
  return {
    id: 'cursor', label: 'Cursor', command: launch.command, prefixArgs: launch.prefixArgs, env: launch.env, promptMode: 'argument',
    buildArgs: (prompt) => ['--print', '--output-format', 'stream-json', '--force', prompt],
    formatCommand: (workspace) => `cursor-agent --print --output-format stream-json --force (${launch.viaBundledNode ? 'via=node ' : ''}cwd=${workspace})`,
    parseStdout: parseCursorStdout,
    parseStderr: (line, context) => stderrLog('cursor', context, line),
  };
}

export function getAgentExecutor(id: AgentExecutorId) {
  return id === 'cursor' ? cursorExecutor() : executors[id];
}
