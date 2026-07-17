import { createHash, randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { toUtcIsoString } from './event-time';

export type RuntimeEventSeverity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type RuntimeEventContext = {
  runId?: string | null;
  executionId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  stage?: string | null;
};

let processContext: RuntimeEventContext = {};

const severityNumber: Record<RuntimeEventSeverity, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const secretPattern = /((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[=:]\s*)([^\s,;]+)/ig;

export function sanitizeRuntimeText(input: unknown, limit = 12_000) {
  const value = String(input ?? '').replace(secretPattern, '$1[REDACTED]');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function setRuntimeEventContext(context: RuntimeEventContext) {
  processContext = { ...processContext, ...context };
}

export function clearRuntimeEventContext() {
  processContext = {};
}

function inferSeverity(message: string): RuntimeEventSeverity {
  if (/\[(?:执行器错误|错误|致命)\]|\b(?:fatal|panic)\b/i.test(message)) return 'ERROR';
  if (/\[(?:警告)\]|失败|\b(?:fail|failed|warn|warning|timeout|timed out)\b/i.test(message)) return 'WARN';
  return 'INFO';
}

function inferEventName(message: string) {
  if (message.startsWith('[执行器工具]')) return 'loop.agent.tool';
  if (message.startsWith('[执行器错误]')) return 'loop.agent.error';
  if (message.startsWith('[执行器输出]')) return 'loop.agent.output';
  if (message.startsWith('[验证]')) return 'loop.verification';
  if (message.startsWith('[演化]')) return 'loop.agent_evolution';
  if (message.startsWith('[维护]')) return 'loop.software_maintenance';
  if (message.startsWith('[错误]') || message.startsWith('[执行器错误]')) return 'loop.error';
  if (message.startsWith('[恢复]')) return 'loop.recovery';
  if (message.startsWith('[派发]')) return 'loop.dispatch';
  return 'loop.log';
}

function inferComponent(eventName: string) {
  if (eventName.startsWith('loop.software_maintenance')) return 'software-maintenance';
  if (eventName.startsWith('loop.agent_evolution')) return 'agent-evolution';
  if (eventName.startsWith('loop.agent')) return 'agent-executor';
  if (eventName.startsWith('loop.verification')) return 'harness';
  if (eventName.startsWith('loop.dispatch')) return 'orchestrator';
  return 'loop-runner';
}

function logAttributes(message: string) {
  const attributes: Record<string, string> = {};
  for (const match of message.matchAll(/\b(executor|agent|requirement|unit|flow|tool|code)=([^\s]+)/g)) attributes[match[1]] = match[2];
  return attributes;
}

function exceptionFields(error: unknown) {
  if (!error) return { exceptionType: null, exceptionMessage: null, exceptionStack: null, exceptionFingerprint: null };
  const exceptionType = error instanceof Error ? error.name : typeof error;
  const exceptionMessage = sanitizeRuntimeText(error instanceof Error ? error.message : error, 3000);
  const exceptionStack = sanitizeRuntimeText(error instanceof Error ? error.stack || '' : '', 12_000);
  const normalized = `${exceptionType}:${exceptionMessage.replace(/\b\d+\b/g, '#').replace(/[a-f0-9]{8,}/ig, '<id>')}`;
  return {
    exceptionType,
    exceptionMessage,
    exceptionStack,
    exceptionFingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 24),
  };
}

type RuntimeEventInput = {
  eventName: string;
  component: string;
  body: unknown;
  severity?: RuntimeEventSeverity;
  context?: RuntimeEventContext;
  attributes?: Record<string, unknown>;
  error?: unknown;
};

export function recordRuntimeEventInDb(db: Awaited<ReturnType<typeof databaseConnection>>, input: RuntimeEventInput) {
  const context = { ...processContext, ...input.context };
  const severity = input.severity || 'INFO';
  const timestamp = toUtcIsoString();
  const exception = exceptionFields(input.error);
  const info = db.prepare(`
    INSERT INTO runtime_events(
      timestamp, observed_at, trace_id, span_id, run_id, execution_id, task_id, agent_id,
      event_name, component, stage, severity_text, severity_number, body, attributes_json,
      exception_type, exception_message, exception_stack, exception_fingerprint
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp, timestamp, context.runId || null, context.executionId || null,
    context.runId || null, context.executionId || null, context.taskId || null, context.agentId || null,
    input.eventName, input.component, context.stage || null, severity, severityNumber[severity],
    sanitizeRuntimeText(input.body), JSON.stringify(input.attributes || {}),
    exception.exceptionType, exception.exceptionMessage, exception.exceptionStack, exception.exceptionFingerprint,
  );
  return Number(info.lastInsertRowid);
}

export async function recordRuntimeEvent(input: RuntimeEventInput) {
  const db = await databaseConnection();
  return recordRuntimeEventInDb(db, input);
}

export function recordLoopLogEventInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  const eventName = inferEventName(message);
  return recordRuntimeEventInDb(db, {
    eventName,
    component: inferComponent(eventName),
    body: message,
    severity: inferSeverity(message),
    context: { runId },
    attributes: logAttributes(message),
  });
}

export async function recordLoopLogEvent(runId: string, message: string) {
  const db = await databaseConnection();
  return recordLoopLogEventInDb(db, runId, message);
}

export async function recordRuntimeException(input: { runId?: string; executionId?: string; component: string; stage: string; error: unknown; fatal?: boolean }) {
  return recordRuntimeEvent({
    eventName: input.fatal ? 'loop.exception.fatal' : 'loop.exception',
    component: input.component,
    body: input.error instanceof Error ? input.error.message : String(input.error),
    severity: input.fatal ? 'FATAL' : 'ERROR',
    context: { runId: input.runId, executionId: input.executionId, stage: input.stage },
    error: input.error,
  });
}

export function newCorrelationId() {
  return randomUUID();
}
