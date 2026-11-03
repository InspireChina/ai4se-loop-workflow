import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentCommandRejectedError,
  renderAgentCommandRejection,
  commandResultMetadata,
} from './agent-command-rejection';

test('renders every generic command rejection as a structured and actionable receipt', () => {
  const error = new AgentCommandRejectedError({
    code: 'schema_enum',
    path: 'verification/results/smoke.status',
    message: '结果状态无效',
    occurrence: 2,
    schemaCommand: 'schema show --artifact verification --block results',
    templateCommand: 'artifact template --artifact verification --block results',
    issues: [{
      code: 'schema_enum',
      path: 'verification/results/smoke.status',
      message: '枚举值无效',
      expected: 'passed | failed | blocked',
      received: 'success',
    }],
  });
  const output = renderAgentCommandRejection('artifact put', error.commandRejection);
  assert.match(output, /# COMMAND RESULT/);
  assert.match(output, /- Outcome: rejected/);
  assert.match(output, /- Error-Code: schema_enum/);
  assert.match(output, /- Occurrence: 2/);
  assert.match(output, /- Action: refresh_schema_and_retry/);
  assert.match(output, /passed \| failed \| blocked/);
  assert.match(output, /不要继续猜测字段/);
});

test('native tool results and escaped legacy summaries retain exact rejection identifiers', () => {
  const body='# COMMAND RESULT\n\n- Outcome: rejected\n- Error-Code: schema_enum\n- Error-Path: verification/results/smoke.status\n- Occurrence: 2\n\n# NEXT\n';
  const output={content:[{type:'text',text:body}]};
  const expected={commandOutcome:'rejected',commandErrorCode:'schema_enum',commandErrorPath:'verification/results/smoke.status',commandRejectionOccurrence:2};
  assert.deepEqual(commandResultMetadata(output),expected);
  assert.deepEqual(commandResultMetadata(undefined,JSON.stringify(output)),expected);
  assert.deepEqual(commandResultMetadata(body),expected);
});
