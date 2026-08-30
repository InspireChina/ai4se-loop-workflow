import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVELOPMENT_COMMAND_CHAIN,
  DEVELOPMENT_PHASE_ORDER,
  DEVELOPMENT_PHASE_SEQUENCE,
  DEVELOPMENT_WORKFLOW,
  developmentNormalCommandPath,
} from './development-workflow';

test('defines Development entirely from the YAML command chain', () => {
  assert.equal(DEVELOPMENT_COMMAND_CHAIN.agent, 'dev-agent');
  assert.deepEqual(DEVELOPMENT_PHASE_ORDER, [
    'delivery_spec', 'implement', 'review', 'developer_verify', 'commit', 'finalize',
  ]);
  assert.equal(
    DEVELOPMENT_PHASE_SEQUENCE,
    'DELIVERY SPEC → IMPLEMENT → REVIEW → DEVELOPER VERIFY → COMMIT → FINALIZE',
  );
  assert.equal(DEVELOPMENT_WORKFLOW.delivery_spec.builtin, 'delivery-spec');
  assert.equal(DEVELOPMENT_WORKFLOW.implement.builtin, 'implementation-evidence');
  assert.deepEqual(DEVELOPMENT_WORKFLOW.implement.artifactBlocks, [
    { artifactId: 'development', blockId: 'recovery-resolutions' },
  ]);
  assert.match(DEVELOPMENT_WORKFLOW.implement.commands.join('\n'), /acceptance assess/);
  assert.match(DEVELOPMENT_WORKFLOW.implement.commands.join('\n'), /runtime-input put/);
  assert.deepEqual(DEVELOPMENT_WORKFLOW.review.artifactBlocks, [
    { artifactId: 'development', blockId: 'code-review' },
  ]);
  assert.equal(DEVELOPMENT_WORKFLOW.developer_verify.builtin, 'command-verification');
  assert.match(DEVELOPMENT_WORKFLOW.developer_verify.commands.join('\n'), /check record/);
  assert.equal(DEVELOPMENT_WORKFLOW.commit.type, 'confirmation');
  assert.equal(DEVELOPMENT_WORKFLOW.finalize.type, 'confirmation');
  for (const phase of DEVELOPMENT_PHASE_ORDER) {
    const packet = DEVELOPMENT_WORKFLOW[phase];
    assert.equal(packet.completeCommand, 'phase complete');
    assert.equal('submit' in packet, false);
  }
  assert.deepEqual(developmentNormalCommandPath(), [
    'status',
    'delivery-spec current',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
  ]);
});
