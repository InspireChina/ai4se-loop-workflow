import assert from 'node:assert/strict';
import test from 'node:test';
import { createLangfuseTelemetry, sanitizeLangfuseValue } from './langfuse';

const credentials = { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' };
const context = { runToken: 'run-1', taskId: 'TASK-1', storyIndex: 1, pipeline: 'dev', agent: 'dev-agent' };

test('is disabled by default and when configuration is invalid', () => {
  assert.equal(createLangfuseTelemetry({ env: {} }).isEnabled(context), false);
  assert.equal(createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '2' } }).isEnabled(context), false);
  assert.equal(createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_BASE_URL: 'not a url' } }).isEnabled(context), false);
});

test('sampling handles boundaries and is stable for a context', () => {
  assert.equal(createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '0' } }).isEnabled(context), false);
  assert.equal(createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '1' } }).isEnabled(context), true);
  const telemetry = createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '0.5' } });
  assert.equal(telemetry.isEnabled(context), telemetry.isEnabled(context));
});

test('sanitizes credentials and oversized text while retaining numeric token usage', () => {
  const sanitized = sanitizeLangfuseValue({ authorization: 'Bearer abcdefghijkl', accessToken: 'secret', input_tokens: 12, outputTokens: 4, nested: { password: 'hello' }, text: 'token=abc123 Bearer abcdefghijkl sk-abcdefghi' }) as Record<string, unknown>;
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.accessToken, '[REDACTED]');
  assert.equal(sanitized.input_tokens, 12);
  assert.equal(sanitized.outputTokens, 4);
  assert.deepEqual(sanitized.nested, { password: '[REDACTED]' });
  assert.match(String(sanitized.text), /\[REDACTED\]/);
  assert.match(String(sanitizeLangfuseValue('x'.repeat(5_000))), /\[TRUNCATED\]/);
});

test('does not initialize a client until enabled and sampled, and never captures prompts by default', async () => {
  let created = 0;
  const telemetry = createLangfuseTelemetry({ env: credentials, createClient: () => { created += 1; return {}; } });
  assert.equal(telemetry.preparePrompt(context, 'private prompt'), undefined);
  assert.equal(created, 0);
  await telemetry.withClient(context, async () => 'ok');
  assert.equal(created, 1);
});

test('captures only explicitly enabled prompts and always sanitizes them', () => {
  const telemetry = createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_CAPTURE_PROMPTS: 'true' } });
  assert.equal(telemetry.preparePrompt(context, 'Authorization: Bearer abcdefghijk sk-abcdefghi'), 'Authorization: [REDACTED] [REDACTED]');
});

test('creates a delegation trace with safe metadata and an opt-in prompt, then ends it', async () => {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const telemetry = createLangfuseTelemetry({
    env: { ...credentials, LANGFUSE_CAPTURE_PROMPTS: 'true' },
    createClient: () => ({ trace: (attributes) => {
      created.push(attributes);
      return { update: (attributes) => { updated.push(attributes); } };
    } }),
  });
  const trace = await telemetry.startDelegationTrace(context, { executor: 'codex', prompt: 'Authorization: Bearer abcdefghijk', model: 'gpt-test', reasoningEffort: 'high' });
  await trace.end({ status: 'completed' });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].metadata, {
    runToken: 'run-1', requirementId: 'TASK-1', deliveryUnitIndex: 1, flow: 'dev', agent: 'dev-agent', operation: 'dev', node: 'dev-agent', executor: 'codex', configuredModel: 'gpt-test', reasoningEffort: 'high', usageAvailable: false, promptCaptured: true, promptLength: 33,
  });
  assert.equal(created[0].name, 'loop.dev');
  assert.deepEqual(created[0].tags, ['dev-agent', 'dev', 'codex']);
  assert.deepEqual(created[0].input, { prompt: 'Authorization: [REDACTED]' });
  assert.deepEqual(updated, [{ output: { exitCode: null, timedOut: false }, metadata: { executionStatus: 'completed' } }]);
});

test('does not create a trace or send a prompt when prompt capture is disabled', async () => {
  let traced = 0;
  const telemetry = createLangfuseTelemetry({ env: credentials, createClient: () => ({ trace: () => { traced += 1; return {}; } }) });
  const trace = await telemetry.startDelegationTrace(context, { executor: 'codex', prompt: 'private prompt' });
  await trace.end({ status: 'failed' });
  assert.equal(traced, 1);
});

test('records one paired tool span and readable diagnostics without metadata summaries or value wrappers', async () => {
  const agentSpans: Array<Record<string, unknown>> = [];
  const toolSpans: Array<Record<string, unknown>> = [];
  const toolEnds: Array<Record<string, unknown>> = [];
  const agentEnds: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const telemetry = createLangfuseTelemetry({
    env: credentials,
    createClient: () => ({ trace: () => ({
      update: (attributes) => { updates.push(attributes); },
      span: (attributes) => {
        agentSpans.push(attributes);
        return {
          event: (event) => { events.push(event); },
          span: (tool) => {
            toolSpans.push(tool);
            return { end: (end) => { toolEnds.push(end ?? {}); } };
          },
          end: (end) => { agentEnds.push(end ?? {}); },
        };
      },
    }) }),
  });
  const trace = await telemetry.startDelegationTrace(context, { executor: 'codex', prompt: 'private' });
  await trace.event({ name: 'loop.agent.tool', executor: 'codex', tool: 'shell', toolCallId: 'call-1', sequence: 1, phase: 'started', input: { authorization: 'Bearer private-token' } });
  await trace.event({ name: 'loop.agent.tool', executor: 'codex', tool: 'shell', toolCallId: 'call-1', sequence: 2, phase: 'completed', summary: 'exit=0', output: { exitCode: 0 } });
  await trace.event({ name: 'loop.agent.diagnostic', executor: 'codex', summary: 'WARNING: retry', level: 'WARNING' });
  await trace.end({ status: 'completed', output: '{"outcome":"completed"}', exitCode: 0, timedOut: false });
  assert.equal(agentSpans[0].name, 'agent.dev-agent');
  assert.deepEqual(toolSpans[0], {
    name: 'tool.shell',
    metadata: { executor: 'codex', toolCallId: 'call-1', sequence: 1 },
    input: { authorization: '[REDACTED]' },
    level: 'DEFAULT',
  });
  assert.deepEqual(toolEnds[0], { metadata: { completionSequence: 2 }, output: { exitCode: 0 }, level: 'DEFAULT' });
  assert.deepEqual(events[0], { name: 'agent.diagnostic', metadata: { executor: 'codex', sequence: null }, output: 'WARNING: retry', level: 'WARNING', statusMessage: 'WARNING: retry' });
  assert.deepEqual(agentEnds[0].output, { outcome: 'completed' });
  assert.deepEqual(updates.at(-1), { output: { outcome: 'completed' }, metadata: { executionStatus: 'completed' } });
});

test('swallows client initialization errors', async () => {
  const diagnostics: string[] = [];
  const telemetry = createLangfuseTelemetry({ env: credentials, diagnostic: (code) => diagnostics.push(code), createClient: () => { throw new Error('bad credentials'); } });
  assert.equal(await telemetry.withClient(context, async () => 'unreachable'), undefined);
  assert.deepEqual(diagnostics, ['client-init-failed']);
});

test('swallows client errors and bounds flush and shutdown', async () => {
  const diagnostics: string[] = [];
  const telemetry = createLangfuseTelemetry({
    env: credentials,
    timeoutMs: 5,
    diagnostic: (code) => diagnostics.push(code),
    createClient: () => ({ flushAsync: async () => new Promise(() => {}), shutdownAsync: async () => { throw new Error('network failure'); } }),
  });
  await telemetry.withClient(context, () => { throw new Error('boom'); });
  await telemetry.flush();
  await telemetry.shutdown();
  assert.deepEqual(diagnostics, ['client-operation-failed', 'client-timeout', 'client-operation-failed']);
});
