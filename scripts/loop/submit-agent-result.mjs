#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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
if (!resultPath || !protocol || !kind) fail('result channel is unavailable outside an active Agent execution');

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
if (typeof result.summary !== 'string' || !result.summary.trim()) fail('result.summary must be a non-empty string');
if (kind === 'flow' && !['completed', 'needs_input', 'failed'].includes(result.outcome)) fail('flow result.outcome must be completed, needs_input, or failed');
if (kind === 'evolution' && !Array.isArray(result.observations)) fail('evolution result.observations must be an array');
if (kind === 'maintenance' && !['no_issue', 'fixed', 'not_repairable'].includes(result.outcome)) fail('maintenance result.outcome must be no_issue, fixed, or not_repairable');
if (!['flow', 'evolution', 'maintenance'].includes(kind)) fail(`unsupported result kind: ${kind}`);

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
