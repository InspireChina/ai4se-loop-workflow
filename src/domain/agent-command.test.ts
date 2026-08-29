import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentCommand } from './agent-command';

test('parses a status command into the shared command model', () => {
  assert.deepEqual(parseAgentCommand(['status']), {
    raw: 'status',
    positionals: ['status'],
    flags: new Map(),
    namespace: null,
    resource: null,
    action: 'status',
    kind: 'status',
  });
});

test('classifies writes, transitions, and terminal actions', () => {
  assert.equal(parseAgentCommand(['artifact', 'put', '--key', 'login']).kind, 'write');
  assert.equal(parseAgentCommand(['check', 'record', '--key', 'test']).kind, 'write');
  assert.equal(parseAgentCommand(['phase', 'complete']).kind, 'transition');
  assert.equal(parseAgentCommand(['phase', 'rewind', '--to', 'impact_scan', '--reason', '补充影响']).kind, 'transition');
  assert.equal(parseAgentCommand(['delivery-spec', 'current']).kind, 'status');
});

test('keeps help and identity outside an agent namespace', () => {
  assert.equal(parseAgentCommand(['help', 'finish']).kind, 'help');
  assert.equal(parseAgentCommand(['whoami']).kind, 'identity');
});
