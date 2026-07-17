import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSoftwareMaintenanceResult, softwareMaintenanceResultSchema } from './software-maintenance';

test('parses a bounded software maintenance result', () => {
  const result = parseSoftwareMaintenanceResult(`\`\`\`json
  {"outcome":"fixed","fingerprint":"runner-loses-final-output","classification":"loop_bug","summary":"The durable output was not resumed after a runner restart.","rootCause":"Recovery selected the wrong execution state.","confidence":0.94,"changedFiles":["src/application/executions.ts"],"tests":[{"command":"npm test","passed":true,"summary":"passed"}],"followUp":""}
  \`\`\``);
  assert.equal(result.outcome, 'fixed');
  assert.equal(result.classification, 'loop_bug');
  assert.deepEqual(result.changedFiles, ['src/application/executions.ts']);
});

test('rejects maintenance output with an unstable fingerprint or excessive files', () => {
  assert.throws(() => softwareMaintenanceResultSchema.parse({
    outcome: 'fixed', fingerprint: 'bad fingerprint', classification: 'loop_bug',
    summary: 'This result should be rejected by the maintenance contract.', rootCause: 'invalid data', confidence: 1,
    changedFiles: Array.from({ length: 13 }, (_, index) => `file-${index}.ts`), tests: [], followUp: '',
  }));
});
