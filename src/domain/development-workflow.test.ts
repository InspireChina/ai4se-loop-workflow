import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVELOPMENT_PHASE_ORDER,
  DEVELOPMENT_PHASE_SEQUENCE,
  DEVELOPMENT_WORKFLOW,
  developmentNormalCommandPath,
} from './development-workflow';

test('defines the Development phase order and work packets in one catalog', () => {
  assert.deepEqual(DEVELOPMENT_PHASE_ORDER, ['implement', 'review', 'developer_verify', 'commit', 'finalize']);
  assert.equal(DEVELOPMENT_PHASE_SEQUENCE, 'IMPLEMENT → REVIEW → DEVELOPER VERIFY → COMMIT → FINALIZE');
  for (const phase of DEVELOPMENT_PHASE_ORDER) {
    const packet = DEVELOPMENT_WORKFLOW[phase];
    assert.ok(packet.title);
    assert.ok(packet.objective);
    assert.ok(packet.required);
    assert.ok(packet.prohibited);
    assert.ok(packet.commands.length);
    assert.ok(packet.reviewBeforeSubmit.length);
    assert.match(packet.submit, /^implementation /);
  }
  assert.deepEqual(developmentNormalCommandPath(), [
    'implementation implement complete',
    'implementation review complete',
    'implementation verify complete',
    'implementation commit complete',
    'implementation validate',
    'implementation complete',
  ]);
});
