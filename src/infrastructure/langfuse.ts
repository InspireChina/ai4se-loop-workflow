import { Langfuse } from 'langfuse';

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;
const MAX_ITEMS = 50;
const MAX_TEXT_LENGTH = 4_096;
// `runToken` is an execution correlation ID, not an authentication token. It must remain
// queryable in Langfuse while actual credential-bearing token fields are redacted.
const SENSITIVE_KEY = /(?:api[-_]?key|secret|password|passphrase|authorization|cookie|credential|access[-_]?token|refresh[-_]?token|^(?!runToken$).*token)/i;
const TOKEN_COUNT_KEY = /(?:^|[_-])tokens?$|Tokens$/;

export type TelemetryContext = {
  runToken?: string;
  taskId?: string;
  storyIndex?: number | null;
  pipeline?: string;
  agent?: string;
};

export type LangfuseClient = {
  trace?: (attributes: LangfuseTracePayload) => LangfuseTraceClient;
  flushAsync?: () => Promise<unknown>;
  shutdownAsync?: () => Promise<unknown>;
};

type LangfuseTracePayload = {
  name: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  tags?: string[];
};

type LangfuseTraceClient = {
  update?: (attributes: Partial<LangfuseTracePayload>) => unknown;
  event?: (attributes: LangfuseObservationPayload) => LangfuseObservationClient | unknown;
  span?: (attributes: LangfuseObservationPayload) => LangfuseSpanClient;
};

type LangfuseObservationPayload = {
  name: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
};

type LangfuseObservationClient = {
  event?: (attributes: LangfuseObservationPayload) => unknown;
  span?: (attributes: LangfuseObservationPayload) => LangfuseSpanClient;
};

type LangfuseSpanClient = LangfuseObservationClient & {
  end?: (attributes?: Omit<LangfuseObservationPayload, 'name' | 'input'>) => unknown;
};

export type DelegationTraceAttributes = {
  executor: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
};

export type DelegationTraceEndAttributes = {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'execution_error';
  output?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  metrics?: {
    model?: string;
    usage?: Record<string, unknown>;
    totalCostUsd?: number;
    durationMs?: number;
  };
};

export type DelegationTelemetryEvent = {
  name: 'loop.agent.lifecycle' | 'loop.agent.tool' | 'loop.agent.output' | 'loop.agent.diagnostic';
  phase?: 'started' | 'completed';
  executor: string;
  tool?: string;
  toolCallId?: string;
  sequence?: number;
  summary?: string;
  input?: unknown;
  output?: unknown;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
};

export type DelegationTrace = {
  event(attributes: DelegationTelemetryEvent): Promise<void>;
  end(attributes: DelegationTraceEndAttributes): Promise<void>;
};

export type LangfuseTelemetryOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  createClient?: (config: { publicKey: string; secretKey: string; baseUrl: string }) => LangfuseClient;
  diagnostic?: (code: 'client-init-failed' | 'client-operation-failed' | 'client-timeout') => void;
  timeoutMs?: number;
};

export type LangfuseTelemetry = {
  isEnabled(context: TelemetryContext): boolean;
  shouldCapturePrompts(context: TelemetryContext): boolean;
  sanitize(value: unknown): unknown;
  preparePrompt(context: TelemetryContext, prompt: string): string | undefined;
  startDelegationTrace(context: TelemetryContext, attributes: DelegationTraceAttributes): Promise<DelegationTrace>;
  withClient<T>(context: TelemetryContext, operation: (client: LangfuseClient) => Promise<T> | T): Promise<T | undefined>;
  safe<T>(operation: () => Promise<T> | T): Promise<T | undefined>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

type ParsedConfig = {
  enabled: boolean;
  sampleRate: number;
  capturePrompts: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
};

function enabledFlag(value: string | undefined) {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function parseConfig(env: Readonly<Record<string, string | undefined>>): ParsedConfig {
  const enabled = enabledFlag(env.LANGFUSE_ENABLED);
  const sampleRateRaw = env.LANGFUSE_SAMPLE_RATE?.trim();
  const sampleRate = sampleRateRaw === undefined || sampleRateRaw === '' ? 1 : Number(sampleRateRaw);
  const validSampleRate = Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1;
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = env.LANGFUSE_BASE_URL?.trim();
  let validBaseUrl = Boolean(baseUrl);
  try {
    const url = new URL(baseUrl || '');
    validBaseUrl = url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    validBaseUrl = false;
  }

  return {
    enabled: enabled && validSampleRate && Boolean(publicKey && secretKey) && validBaseUrl,
    sampleRate: validSampleRate ? sampleRate : 0,
    capturePrompts: enabledFlag(env.LANGFUSE_CAPTURE_PROMPTS),
    publicKey,
    secretKey,
    baseUrl,
  };
}

function stableSample(context: TelemetryContext, sampleRate: number) {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  const key = [context.runToken, context.taskId, context.storyIndex, context.pipeline, context.agent].map((value) => String(value ?? '')).join('|');
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < sampleRate;
}

function redactText(value: string, maxTextLength = MAX_TEXT_LENGTH) {
  const truncated = value.length > maxTextLength ? `${value.slice(0, maxTextLength)}…[TRUNCATED]` : value;
  return truncated
    .replace(/(\b(?:api[-_]?key|secret|password|passphrase|authorization|cookie|credential|access[-_]?token|refresh[-_]?token|token))\s*([:=])\s*((?:(?:Bearer|Basic)\s+)?[^\s,;"']+)/gi, `$1$2 ${REDACTED}`)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$&'.split(/\s+/)[0] + ' ' + REDACTED)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{6,}\b/g, REDACTED);
}

function sanitizeWithLimit(value: unknown, maxTextLength: number, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value, maxTextLength);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeWithLimit(item, maxTextLength, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
    const numericTokenCount = typeof item === 'number' && TOKEN_COUNT_KEY.test(key);
    result[key] = SENSITIVE_KEY.test(key) && !numericTokenCount ? REDACTED : sanitizeWithLimit(item, maxTextLength, depth + 1, seen);
  }
  return result;
}

export function sanitizeLangfuseValue(value: unknown): unknown {
  return sanitizeWithLimit(value, MAX_TEXT_LENGTH);
}

function sanitizeFinalOutput(value: unknown) {
  return sanitizeWithLimit(value, 64 * 1024);
}

function observationSegment(value: string | undefined, fallback: string) {
  const normalized = (value || fallback).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function structuredOutput(value: string | undefined) {
  if (!value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

async function withTimeout(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    return 'ok' as const;
  } catch (error) {
    return error instanceof Error && error.message === 'timeout' ? 'timeout' as const : 'failed' as const;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createLangfuseTelemetry(options: LangfuseTelemetryOptions = {}): LangfuseTelemetry {
  const config = parseConfig(options.env ?? process.env);
  const createClient = options.createClient ?? ((clientConfig) => new Langfuse(clientConfig));
  const timeoutMs = options.timeoutMs ?? 2_000;
  let client: LangfuseClient | undefined;

  const isEnabled = (context: TelemetryContext) => config.enabled && stableSample(context, config.sampleRate);
  const report = (code: 'client-init-failed' | 'client-operation-failed' | 'client-timeout') => {
    try { options.diagnostic?.(code); } catch { /* diagnostics must never affect execution */ }
  };
  const getClient = (context: TelemetryContext) => {
    if (!isEnabled(context)) return undefined;
    if (client) return client;
    try {
      client = createClient({ publicKey: config.publicKey!, secretKey: config.secretKey!, baseUrl: config.baseUrl! });
      return client;
    } catch {
      report('client-init-failed');
      return undefined;
    }
  };
  const noOpTrace: DelegationTrace = { event: async () => undefined, end: async () => undefined };

  return {
    isEnabled,
    shouldCapturePrompts: (context) => isEnabled(context) && config.capturePrompts,
    sanitize: (value) => sanitizeLangfuseValue(value),
    preparePrompt: (context, prompt) => isEnabled(context) && config.capturePrompts ? redactText(prompt) : undefined,
    async startDelegationTrace(context, attributes) {
      const prompt = isEnabled(context) ? this.preparePrompt(context, attributes.prompt) : undefined;
      const metadata = sanitizeLangfuseValue({
        runToken: context.runToken ?? null,
        requirementId: context.taskId ?? null,
        deliveryUnitIndex: context.storyIndex ?? null,
        flow: context.pipeline ?? null,
        agent: context.agent ?? null,
        operation: context.pipeline ?? null,
        node: context.agent ?? null,
        executor: attributes.executor,
        configuredModel: attributes.model ?? null,
        reasoningEffort: attributes.reasoningEffort ?? null,
        usageAvailable: false,
        promptCaptured: Boolean(prompt),
        promptLength: attributes.prompt.length,
      }) as Record<string, unknown>;
      const trace = await this.withClient(context, (activeClient) => activeClient.trace?.({
        name: `loop.${observationSegment(context.pipeline, 'agent-execution')}`,
        sessionId: context.runToken,
        metadata,
        tags: [context.agent, context.pipeline, attributes.executor].filter((value): value is string => Boolean(value)),
        ...(prompt ? { input: { prompt } } : {}),
      }));
      if (!trace?.update) return noOpTrace;
      const agentSpan = await this.safe(() => trace.span?.({
        name: `agent.${observationSegment(context.agent, 'unknown')}`,
        metadata: sanitizeLangfuseValue({
          executor: attributes.executor,
          operation: context.pipeline ?? null,
          node: context.agent ?? null,
          configuredModel: attributes.model ?? null,
          reasoningEffort: attributes.reasoningEffort ?? null,
          usageAvailable: false,
        }) as Record<string, unknown>,
      }));
      const parent: LangfuseObservationClient = agentSpan ?? trace;
      const toolSpans = new Map<string, { span: LangfuseSpanClient; tool: string }>();
      const anonymousTools = new Map<string, string[]>();
      let anonymousToolSequence = 0;
      let finalOutput: string | undefined;

      const openToolKey = (attributes: DelegationTelemetryEvent) => {
        if (attributes.toolCallId) return attributes.toolCallId;
        const tool = observationSegment(attributes.tool, 'unknown');
        const key = `anonymous:${tool}:${++anonymousToolSequence}`;
        const queue = anonymousTools.get(tool) ?? [];
        queue.push(key);
        anonymousTools.set(tool, queue);
        return key;
      };
      const completedToolKey = (attributes: DelegationTelemetryEvent) => {
        if (attributes.toolCallId) return attributes.toolCallId;
        const tool = observationSegment(attributes.tool, 'unknown');
        const queue = anonymousTools.get(tool);
        return queue?.shift() ?? `orphan:${tool}:${++anonymousToolSequence}`;
      };

      return {
        event: async (attributes) => {
          if (attributes.name === 'loop.agent.output') {
            finalOutput = typeof attributes.output === 'string' ? attributes.output : attributes.summary;
            return;
          }
          if (attributes.name === 'loop.agent.lifecycle') return;
          if (attributes.name === 'loop.agent.diagnostic') {
            await this.safe(() => parent.event?.({
              name: 'agent.diagnostic',
              metadata: sanitizeLangfuseValue({ executor: attributes.executor, sequence: attributes.sequence ?? null }) as Record<string, unknown>,
              output: sanitizeLangfuseValue(attributes.summary ?? ''),
              level: attributes.level ?? 'DEFAULT',
              ...(attributes.level && attributes.level !== 'DEFAULT' && attributes.summary ? { statusMessage: redactText(attributes.summary, 1_000) } : {}),
            }));
            return;
          }

          const tool = observationSegment(attributes.tool, 'unknown');
          if (attributes.phase === 'started') {
            const key = openToolKey(attributes);
            await this.safe(() => {
              const span = parent.span?.({
                name: `tool.${tool}`,
                metadata: sanitizeLangfuseValue({ executor: attributes.executor, toolCallId: key, sequence: attributes.sequence ?? null }) as Record<string, unknown>,
                ...(attributes.input === undefined ? {} : { input: sanitizeLangfuseValue(attributes.input) }),
                level: attributes.level ?? 'DEFAULT',
              });
              if (span) toolSpans.set(key, { span, tool });
            });
            return;
          }

          const key = completedToolKey(attributes);
          let open = toolSpans.get(key);
          if (!open) {
            await this.safe(() => {
              const span = parent.span?.({
                name: `tool.${tool}`,
                metadata: sanitizeLangfuseValue({ executor: attributes.executor, toolCallId: key, orphanCompletion: true, sequence: attributes.sequence ?? null }) as Record<string, unknown>,
              });
              if (span) open = { span, tool };
            });
          }
          if (!open) return;
          toolSpans.delete(key);
          const toolOutput = attributes.output === undefined ? attributes.summary : attributes.output;
          await this.safe(() => open!.span.end?.({
            metadata: sanitizeLangfuseValue({ completionSequence: attributes.sequence ?? null }) as Record<string, unknown>,
            ...(toolOutput === undefined ? {} : { output: sanitizeLangfuseValue(toolOutput) }),
            level: attributes.level ?? 'DEFAULT',
            ...(attributes.level && attributes.level !== 'DEFAULT' && attributes.summary ? { statusMessage: redactText(attributes.summary, 1_000) } : {}),
          }));
        },
        end: async ({ status, output, exitCode, timedOut, metrics }) => {
          const result = structuredOutput(output || finalOutput);
          const level = status === 'completed' ? 'DEFAULT' : 'ERROR';
          for (const [key, open] of toolSpans) {
            await this.safe(() => open.span.end?.({
              level: 'ERROR',
              statusMessage: `Agent ended before tool completion (${status})`,
              metadata: sanitizeLangfuseValue({ toolCallId: key, incomplete: true }) as Record<string, unknown>,
            }));
          }
          toolSpans.clear();
          const terminalOutput = result === undefined ? { exitCode: exitCode ?? null, timedOut: Boolean(timedOut) } : result;
          await this.safe(() => agentSpan?.end?.({
            output: sanitizeFinalOutput(terminalOutput),
            metadata: sanitizeLangfuseValue({
              executionStatus: status,
              exitCode: exitCode ?? null,
              timedOut: Boolean(timedOut),
              ...(metrics?.model ? { reportedModel: metrics.model } : {}),
              ...(metrics?.usage ? { usageAvailable: true, reportedUsage: metrics.usage } : {}),
              ...(metrics?.totalCostUsd !== undefined ? { totalCostUsd: metrics.totalCostUsd } : {}),
              ...(metrics?.durationMs !== undefined ? { providerDurationMs: metrics.durationMs } : {}),
            }) as Record<string, unknown>,
            level,
            ...(status === 'completed' ? {} : { statusMessage: status }),
          }));
          await this.safe(() => trace.update?.({
            output: sanitizeFinalOutput(terminalOutput),
            metadata: sanitizeLangfuseValue({
              executionStatus: status,
              ...(metrics?.model ? { reportedModel: metrics.model } : {}),
              ...(metrics?.usage ? { usageAvailable: true } : {}),
              ...(metrics?.totalCostUsd !== undefined ? { totalCostUsd: metrics.totalCostUsd } : {}),
            }) as Record<string, unknown>,
          }));
        },
      };
    },
    async safe<T>(operation: () => Promise<T> | T) {
      try { return await operation(); } catch { report('client-operation-failed'); return undefined; }
    },
    async withClient<T>(context: TelemetryContext, operation: (activeClient: LangfuseClient) => Promise<T> | T) {
      const initialized = getClient(context);
      if (!initialized) return undefined;
      try { return await operation(initialized); } catch { report('client-operation-failed'); return undefined; }
    },
    async flush() {
      if (!client?.flushAsync) return;
      const result = await withTimeout(Promise.resolve().then(() => client!.flushAsync!()), timeoutMs);
      if (result !== 'ok') report(result === 'timeout' ? 'client-timeout' : 'client-operation-failed');
    },
    async shutdown() {
      const activeClient = client;
      client = undefined;
      if (!activeClient?.shutdownAsync) return;
      const result = await withTimeout(Promise.resolve().then(() => activeClient.shutdownAsync!()), timeoutMs);
      if (result !== 'ok') report(result === 'timeout' ? 'client-timeout' : 'client-operation-failed');
    },
  };
}

let sharedTelemetry: LangfuseTelemetry | undefined;

/** The only production entry point for Langfuse telemetry. */
export function getLangfuseTelemetry() {
  sharedTelemetry ??= createLangfuseTelemetry();
  return sharedTelemetry;
}
