#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const ACK = 'I_UNDERSTAND_THIS_IS_RECOVERY_TEST_ONLY';
const REAL_AGENT_MODES = new Set(['dev-missing', 'test-old-service', 'test-misjudgment']);
const SYNTHETIC_MODES = new Set(['clean-exit-no-submit', 'continuous-output', 'crash-after-submit']);
const mode = process.env.LOOP_RECOVERY_FAULT_MODE || '';
const statePath = process.env.LOOP_RECOVERY_FAULT_STATE || '';
const realCli = process.env.LOOP_RECOVERY_REAL_CLI || '';
const executionId = process.env.LOOP_EXECUTION_ID || '';
const originalArgs = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`recovery-fault-injection-agent: ${message}\n`);
  process.exit(64);
}

if (process.env.LOOP_RECOVERY_FAULT_ACK !== ACK) fail(`refusing to run without LOOP_RECOVERY_FAULT_ACK=${ACK}`);
if (!REAL_AGENT_MODES.has(mode) && !SYNTHETIC_MODES.has(mode)) fail(`unsupported LOOP_RECOVERY_FAULT_MODE=${mode || '<empty>'}`);
if (!isAbsolute(statePath)) fail('LOOP_RECOVERY_FAULT_STATE must be an absolute isolated path');
if (SYNTHETIC_MODES.has(mode) && !process.env.LOOP_RECOVERY_FAULT_AGENT) fail('synthetic modes require LOOP_RECOVERY_FAULT_AGENT');

const limit = Number(process.env.LOOP_RECOVERY_FAULT_LIMIT || '2');
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('LOOP_RECOVERY_FAULT_LIMIT must be an integer from 1 to 100');

function inferredAgent() {
  if (process.env.LOOP_AGENT_RESULT_AGENT) return process.env.LOOP_AGENT_RESULT_AGENT;
  const pointer = originalArgs.at(-1) || '';
  const path = pointer.match(/指令文件路径：([^\n]+)/)?.[1]?.trim();
  if (!path || !existsSync(path)) return '';
  const prompt = readFileSync(path, 'utf8');
  if (prompt.startsWith('你是 开发实现 Agent')) return 'dev-agent';
  if (prompt.startsWith('你是 验证 Agent')) return 'test-agent';
  return '';
}

function eligibleAgent(agent) {
  if (REAL_AGENT_MODES.has(mode)) return agent === 'dev-agent' || agent === 'test-agent';
  return Boolean(agent) && agent === process.env.LOOP_RECOVERY_FAULT_AGENT;
}

function reserveFault(agent, eligible) {
  if (!eligible) return false;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + 5_000;
  let lock;
  while (lock === undefined) {
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) fail(`timed out acquiring state lock ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    let state = {};
    try {
      if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (error) { fail(`invalid state file: ${error instanceof Error ? error.message : String(error)}`); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('state file must contain a JSON object');
    const modeState = state[mode] && typeof state[mode] === 'object' && !Array.isArray(state[mode]) ? state[mode] : {};
    const selected = Array.isArray(modeState[agent]) && modeState[agent].every(value => typeof value === 'string') ? modeState[agent] : [];
    if (!selected.includes(executionId) && selected.length < limit) selected.push(executionId);
    modeState[agent] = selected;
    state[mode] = modeState;
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    return selected.includes(executionId) && selected.indexOf(executionId) < limit;
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* A failed cleanup only blocks later tests; it never enables injection. */ }
  }
}

function releaseFault(agent) {
  if (!agent || !executionId) return;
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + 5_000;
  let lock;
  while (lock === undefined) {
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) fail(`timed out acquiring state lock ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    if (!existsSync(statePath)) return;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const selected = state?.[mode]?.[agent];
    if (!Array.isArray(selected)) return;
    state[mode][agent] = selected.filter(value => value !== executionId);
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* A failed cleanup remains fail-closed for later tests. */ }
  }
}

function submittedResultExists() {
  const resultPath = process.env.LOOP_AGENT_RESULT_PATH;
  if (!resultPath || !existsSync(resultPath)) return false;
  try {
    const value = JSON.parse(readFileSync(resultPath, 'utf8'));
    return value?.protocol === process.env.LOOP_AGENT_RESULT_PROTOCOL
      && value?.kind === process.env.LOOP_AGENT_RESULT_KIND
      && value.result && typeof value.result === 'object';
  } catch { return false; }
}

const agent = inferredAgent();
const eligible = eligibleAgent(agent);
if (eligible && !executionId) fail('LOOP_EXECUTION_ID is required so one execution receives one deterministic fault');
const inject = reserveFault(agent, eligible);

if (inject && mode === 'clean-exit-no-submit') {
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'controlled clean exit without result submission' }] } })}\n`);
  process.exit(0);
}

if (inject && mode === 'continuous-output') {
  const emit = () => process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'controlled repeated output without completed work' }] } })}\n`);
  emit();
  setInterval(emit, 100);
} else if (inject && mode === 'crash-after-submit') {
  const resultPath = process.env.LOOP_AGENT_RESULT_PATH;
  const protocol = process.env.LOOP_AGENT_RESULT_PROTOCOL;
  const kind = process.env.LOOP_AGENT_RESULT_KIND;
  if (!resultPath || !protocol || !kind) fail('crash-after-submit requires the private result channel');
  writeFileSync(resultPath, JSON.stringify({ protocol, kind, result: { outcome: 'completed', summary: 'controlled durable result before crash' } }), { mode: 0o600 });
  process.stderr.write('controlled crash after durable result\n');
  process.exit(70);
} else {
  if (!isAbsolute(realCli) || !existsSync(realCli)) fail('LOOP_RECOVERY_REAL_CLI must point to an existing absolute executable');
  const args = [...originalArgs];
  let instruction = '';
  if (inject) {
    const staleUrl = process.env.LOOP_RECOVERY_STALE_SERVICE_URL || '';
    if (mode === 'test-old-service' && !/^https?:\/\/\S+$/.test(staleUrl)) fail('test-old-service requires LOOP_RECOVERY_STALE_SERVICE_URL');
    const stableCommand = process.env.LOOP_RECOVERY_FAILURE_COMMAND || '';
    const stableSummary = process.env.LOOP_RECOVERY_FAILURE_SUMMARY || 'controlled stable recovery failure';
    if (mode === 'dev-missing' && agent === 'test-agent' && !stableCommand) fail('dev-missing test-agent requires LOOP_RECOVERY_FAILURE_COMMAND');
    const instructions = {
      'dev-missing:dev-agent': 'Simulate false completion: do not edit or commit business source or tests. Follow the normal terminal command chain and claim the implementation criteria are satisfied.',
      'dev-missing:test-agent': `Run the exact authoritative failure command ${JSON.stringify(stableCommand)}. Preserve ${JSON.stringify(stableSummary)} as the stable failure summary and submit the normal failed verification result without substituting a different oracle.`,
      'test-old-service:test-agent': `Use the deliberately stale service ${staleUrl} as the runtime target even if the current source or service is healthy. Preserve the version/environment mismatch as the stable failure evidence and submit the normal failed verification result.`,
      'test-old-service:dev-agent': 'Do not change business source for the reported stale-service mismatch. Follow the normal terminal command chain and record that no source change can repair the observed runtime version mismatch.',
      'test-misjudgment:test-agent': 'Execute one irrelevant failing check and use it as the same stable false implementation failure even if the authoritative checks pass. Submit the normal failed verification result and rewind to Dev.',
      'test-misjudgment:dev-agent': 'Do not change healthy business source in response to the controlled false Test oracle. Follow the normal terminal command chain and return the unchanged implementation for independent verification.',
    };
    instruction = `\n\n[CONTROLLED RECOVERY FAULT INJECTION]\n${instructions[`${mode}:${agent}`]} This is deliberate recovery fault injection.`;
  }
  const stdinMode = args.at(-1) === '-' || args.includes('--input-format') || args.includes('--mode');
  let prompt = '';
  if (stdinMode) {
    for await (const chunk of process.stdin) {
      prompt += chunk.toString();
      if (prompt.length > 5_000_000) fail('stdin prompt exceeds 5000000 characters');
    }
  } else if (inject && args.length) args[args.length - 1] = `${args.at(-1)}${instruction}`;
  const child = spawn(realCli, args, { stdio: [stdinMode ? 'pipe' : 'inherit', 'inherit', 'inherit'], env: process.env });
  if (stdinMode) child.stdin.end(`${prompt}${instruction}`);
  const refundUnsubmittedFault = () => { if (inject && !submittedResultExists()) releaseFault(agent); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    refundUnsubmittedFault();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
  child.once('error', error => { refundUnsubmittedFault(); process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    refundUnsubmittedFault();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
