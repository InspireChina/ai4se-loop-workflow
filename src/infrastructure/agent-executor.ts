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

export type AgentTelemetryEvent = {
  name: 'loop.agent.tool' | 'loop.agent.output' | 'loop.agent.diagnostic';
  phase?: 'started' | 'completed';
  executor: AgentExecutorId;
  tool?: string;
  summary?: string;
  input?: unknown;
  output?: unknown;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
};

export type AgentExecutor = {
  id: AgentExecutorId;
  label: string;
  command: string;
  promptMode: 'argument' | 'stdin';
  buildArgs(prompt: string, workspaceRoot: string, options?: AgentExecutionOptions): string[];
  formatCommand(workspaceRoot: string, options?: AgentExecutionOptions): string;
  parseStdout(line: string, context: AgentExecutionContext): string | null;
  parseStderr(line: string, context: AgentExecutionContext): string | null;
};

/** Returns provider-neutral final assistant text when a stream record contains it. */
export function extractAgentFinalText(executor: AgentExecutorId, line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (executor === 'codex') {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === 'item.completed' && item?.type === 'agent_message' ? stringifyValue(item.text) || null : null;
    }
    if (executor === 'claude') return event.type === 'result' && !event.is_error ? stringifyValue(event.result) || null : null;
    if (event.type === 'result' || event.subtype === 'result' || event.subtype === 'success') return stringifyValue(event.result || event.text || event.message) || null;
    return null;
  } catch {
    return null;
  }
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
  return `executor=${executor} agent=${context.agent} task=${context.taskId} story=${context.storyIndex ?? '-'} pipeline=${context.pipeline}`;
}

function toolNameFromCursor(event: Record<string, unknown>) {
  const toolCall = event.tool_call as Record<string, unknown> | undefined;
  const key = toolCall ? Object.keys(toolCall).find((item) => item.endsWith('ToolCall')) : undefined;
  const payload = key ? toolCall?.[key] as Record<string, unknown> | undefined : undefined;
  return {
    tool: key ? key.replace(/ToolCall$/, '') : stringifyValue(event.tool || event.name || 'unknown'),
    args: payload?.args as Record<string, unknown> | undefined,
    result: payload?.result as Record<string, unknown> | undefined,
  };
}

function summarizeCommand(command: string) {
  if (!command) return '';
  if (command.includes(' task-context ')) return '读取数据库 Task 上下文';
  if (command.includes(' document-list ')) return '列出数据库文档';
  if (command.includes(' document-get ')) return '读取数据库文档';
  if (command.includes(' document-upsert ')) return '保存数据库文档';
  if (command.includes(' story-add ')) return '新增 Story';
  if (command.includes(' task-update ')) return '更新 Task 状态';
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

function telemetryOutput(executor: AgentExecutorId, summary: string): AgentTelemetryEvent | null {
  const compacted = compact(summary, 500);
  return compacted ? { name: 'loop.agent.output', executor, summary: compacted } : null;
}

function telemetryDiagnostic(executor: AgentExecutorId, summary: string, level: 'WARNING' | 'ERROR' = 'ERROR'): AgentTelemetryEvent {
  return { name: 'loop.agent.diagnostic', executor, summary: compact(summary, 500), level };
}

/** Converts a single CLI JSONL record into a small, provider-neutral telemetry event. */
export function parseAgentTelemetryStdout(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (executor === 'cursor') {
      const { tool, args, result } = toolNameFromCursor(event);
      if (String(event.type) === 'tool_call' || event.tool_call) {
        const completed = String(event.subtype) === 'completed';
        return { name: 'loop.agent.tool', executor, tool, phase: completed ? 'completed' : 'started', summary: completed ? summarizeResult(result) : summarizeCommand(stringifyValue(args?.command)) || stringifyValue(args?.description), ...(completed ? { output: result } : { input: args }) };
      }
      if (event.type === 'user' || event.type === 'system') return null;
      return telemetryOutput(executor, stringifyValue(event.text || event.message || event.delta || event.content || event.result));
    }
    if (executor === 'codex') {
      const type = String(event.type || '');
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = String(item?.type || '');
      if ((type === 'item.started' || type === 'item.completed') && item && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(itemType)) {
        const completed = type === 'item.completed';
        const tool = itemType === 'command_execution' ? 'shell' : stringifyValue(item.name || itemType);
        const detail = itemType === 'command_execution' ? summarizeCommand(stringifyValue(item.command)) : stringifyValue(item.arguments || item.changes || item.query);
        return { name: 'loop.agent.tool', executor, tool, phase: completed ? 'completed' : 'started', summary: completed ? compact(stringifyValue(item.aggregated_output || item.result || item.exit_code), 500) : compact(detail, 500), ...(completed ? { output: item.aggregated_output || item.result || item.exit_code } : { input: item.arguments || item.command || item.changes || item.query }) };
      }
      if (type === 'error' || type === 'turn.failed') return telemetryDiagnostic(executor, stringifyValue(event.message || event.error || line));
      if (itemType === 'agent_message' || itemType === 'reasoning') return telemetryOutput(executor, stringifyValue(item?.text));
      return null;
    }
    const type = String(event.type || '');
    if (type === 'assistant') {
      const blocks = claudeContentBlocks(event);
      const toolUse = blocks.find((block) => block.type === 'tool_use');
      if (toolUse) return { name: 'loop.agent.tool', executor, tool: stringifyValue(toolUse.name), phase: 'started', summary: summarizeCommand(stringifyValue((toolUse.input as Record<string, unknown> | undefined)?.command)), input: toolUse.input };
      return telemetryOutput(executor, blocks.map((block) => stringifyValue(block.text)).filter(Boolean).join(''));
    }
    if (type === 'user') {
      const toolResult = claudeContentBlocks(event).find((block) => block.type === 'tool_result');
      if (toolResult) return { name: 'loop.agent.tool', executor, tool: stringifyValue(toolResult.tool_use_id || 'tool'), phase: 'completed', summary: compact(stringifyValue(toolResult.content), 500), output: toolResult.content };
    }
    if (type === 'result' && event.is_error) return telemetryDiagnostic(executor, stringifyValue(event.result || event.error || line));
    if (type === 'result') return telemetryOutput(executor, stringifyValue(event.result));
    return null;
  } catch {
    return telemetryOutput(executor, line);
  }
}

export function parseAgentTelemetryStderr(executor: AgentExecutorId, line: string): AgentTelemetryEvent | null {
  const text = compact(line, 500);
  if (!text) return null;
  if (executor === 'codex' && (/^Reading additional input from stdin\.\.\.$/.test(text) || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(text))) return null;
  const error = /(?:^|\s)(?:ERROR|FATAL|PANIC)(?:\s|:)/i.test(text) || /^Error:/i.test(text);
  return telemetryDiagnostic(executor, text, error ? 'ERROR' : 'WARNING');
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

const executors: Record<AgentExecutorId, AgentExecutor> = {
  cursor: {
    id: 'cursor', label: 'Cursor', command: process.env.CURSOR_CLI || 'cursor', promptMode: 'argument',
    buildArgs: (prompt, workspace) => ['agent', '--print', '--output-format', 'stream-json', '--trust', '--force', '--workspace', workspace, prompt],
    formatCommand: (workspace) => `cursor agent --print --output-format stream-json --force --workspace ${workspace}`,
    parseStdout: parseCursorStdout,
    parseStderr: (line, context) => stderrLog('cursor', context, line),
  },
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

export function getAgentExecutor(id: AgentExecutorId) {
  return executors[id];
}
