#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';

function fail(message) {
  process.stderr.write(`submit-agent-result: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
if (inputIndex < 0 || !args[inputIndex + 1]) fail('usage: submit-agent-result --input <result.json> [--consume]');
const consumeInput = args.includes('--consume');
const resultPath = process.env.LOOP_AGENT_RESULT_PATH;
const protocol = process.env.LOOP_AGENT_RESULT_PROTOCOL;
const kind = process.env.LOOP_AGENT_RESULT_KIND;
const agent = process.env.LOOP_AGENT_RESULT_AGENT;
if (!resultPath || !protocol || !kind) fail('result channel is unavailable outside an active Agent execution');
if (kind === 'flow' && !agent) fail('flow result role is unavailable outside an active Agent execution');

const inputArgument = args[inputIndex + 1];
const inputPath = isAbsolute(inputArgument) ? inputArgument : resolve(process.cwd(), inputArgument);
let raw;
let result;
try {
  raw = readFileSync(inputPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) fail('input exceeds the 2 MiB limit');
  result = JSON.parse(raw);
} catch (error) {
  fail(`cannot read valid JSON from ${inputArgument}: ${error instanceof Error ? error.message : String(error)}`);
}
if (!result || typeof result !== 'object' || Array.isArray(result)) fail('top-level result must be a JSON object');
if (!['flow', 'evolution', 'maintenance'].includes(kind)) fail(`unsupported result kind: ${kind}`);

function validationMessage(error) {
  if (Array.isArray(error?.issues)) return JSON.stringify(error.issues, null, 2);
  return error instanceof Error ? error.message : String(error);
}

try {
  if (kind === 'flow') {
    const { agentResultSchema, assertAgentResultRoleContract } = await tsImport('../../src/domain/agent-result.ts', import.meta.url);
    result = agentResultSchema.parse(result);
    assertAgentResultRoleContract(result, agent);
  } else if (kind === 'evolution') {
    const { evolutionResultSchema } = await tsImport('../../src/domain/agent-evolution.ts', import.meta.url);
    result = evolutionResultSchema.parse(result);
  } else {
    const { softwareMaintenanceResultSchema } = await tsImport('../../src/domain/software-maintenance.ts', import.meta.url);
    result = softwareMaintenanceResultSchema.parse(result);
  }
} catch (error) {
  fail(`result does not satisfy the ${kind} contract:\n${validationMessage(error)}`);
}

try {
  // Runner reads only after the Agent process exits, so direct replacement is safe
  // and lets an Agent correct an earlier submission consistently on Windows.
  writeFileSync(resultPath, JSON.stringify({ protocol, kind, result }), { encoding: 'utf8', mode: 0o600 });
  if (consumeInput && resolve(inputPath) !== resolve(resultPath)) {
    try { unlinkSync(inputPath); } catch { /* submission succeeded; input cleanup is best-effort */ }
  }
} catch (error) {
  fail(`cannot publish result: ${error instanceof Error ? error.message : String(error)}`);
}
process.stdout.write('Agent result submitted successfully.\n');
