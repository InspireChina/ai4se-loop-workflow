import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERY_ANALYSIS_COMMAND_CHAIN,
  DELIVERY_ANALYSIS_PHASE_ORDER,
  DELIVERY_ANALYSIS_PHASE_SEQUENCE,
  DELIVERY_ANALYSIS_WORKFLOW,
  deliveryAnalysisNormalCommandPath,
} from './delivery-analysis-workflow';

test('defines the Delivery Analysis phase order and work packets in one catalog', () => {
  assert.equal('compiler' in DELIVERY_ANALYSIS_COMMAND_CHAIN, false);
  assert.deepEqual(Object.keys(DELIVERY_ANALYSIS_COMMAND_CHAIN.artifacts['delivery-analysis'].blocks), [
    'impacts', 'answer-review', 'summary', 'contract', 'guardrails', 'verification-focus',
  ]);
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.decision_resolution.contexts, [
    'analysis-decision-policy',
  ]);
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.decision_resolution.artifactBlocks, [
    { artifactId: 'delivery-analysis', blockId: 'impacts' },
  ]);
  const impactScan = DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.impact_scan;
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.artifacts['delivery-analysis'].blocks.impacts.title, '现状与影响扫描');
  assert.equal(impactScan.type, 'artifact');
  assert.deepEqual(impactScan.artifactBlocks, [{ artifactId: 'delivery-analysis', blockId: 'impacts' }]);
  assert.equal(impactScan.title, 'IMPACT SCAN');
  assert.match(impactScan.instructions, /登记真正会改变、保持、排除或需要决策的影响/);
  assert.deepEqual(impactScan.commands, [
    'artifact put --artifact delivery-analysis --block impacts --key <key> --content-file <yaml>',
    'artifact remove --artifact delivery-analysis --block impacts --key <key>',
    'phase complete',
    'phase rewind --to <earlier-phase> --reason <原因>',
  ]);
  assert.deepEqual(impactScan.validators, ['artifact-schema', 'artifact-required:delivery-analysis.impacts']);
  const deliveryContract = DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.delivery_contract;
  assert.equal(deliveryContract.type, 'artifact');
  assert.deepEqual(deliveryContract.artifactBlocks, [
    { artifactId: 'delivery-analysis', blockId: 'summary' },
    { artifactId: 'delivery-analysis', blockId: 'contract' },
    { artifactId: 'delivery-analysis', blockId: 'guardrails' },
    { artifactId: 'delivery-analysis', blockId: 'verification-focus' },
  ]);
  assert.deepEqual(deliveryContract.validators, [
    'artifact-schema',
    'artifact-required:delivery-analysis.summary',
    'artifact-required:delivery-analysis.contract',
  ]);
  assert.deepEqual(deliveryContract.transitions, [
    'delivery_unit', 'impact_scan', 'decision_proposal', 'decision_resolution', 'answer_review', 'finalize',
  ]);
  assert.match(deliveryContract.commands.join('\n'), /phase rewind --to <earlier-phase> --reason <原因>/);
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.delivery_unit.builtin, 'delivery-unit');
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.decision_proposal.builtin, 'decision-proposal');
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.decision_resolution.builtin, 'decision-resolution');
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.answer_review.builtin, 'decision-answer-review');
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.answer_review.artifactBlocks, [
    { artifactId: 'delivery-analysis', blockId: 'answer-review' },
  ]);
  assert.match(
    DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.answer_review.commands.join('\n'),
    /artifact put --artifact delivery-analysis --block answer-review --content-file <markdown>/,
  );
  assert.ok(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.answer_review.validators.includes(
    'artifact-required:delivery-analysis.answer-review',
  ));
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.finalize.type, 'confirmation');
  assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.finalize.builtin, null);
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.finalize.validators, []);
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases.finalize.commands, [
    'phase complete',
    'phase rewind --to <earlier-phase> --reason <原因>',
  ]);
  assert.deepEqual(DELIVERY_ANALYSIS_COMMAND_CHAIN.decisionTrees.decisions, {
    builtin: 'decisions',
    minOptions: 2,
    recommendationAuthorities: ['upstream', 'user', 'project_evidence', 'agent_authority'],
    resolutionAuthorities: ['upstream', 'user', 'project_evidence', 'agent_authority'],
  });
  assert.deepEqual(DELIVERY_ANALYSIS_PHASE_ORDER, [
    'delivery_unit', 'impact_scan', 'decision_proposal', 'decision_resolution', 'answer_review', 'delivery_contract', 'finalize',
  ]);
  assert.equal(
    DELIVERY_ANALYSIS_PHASE_SEQUENCE,
    'DELIVERY UNIT → IMPACT SCAN → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → ANSWER REVIEW → DELIVERY CONTRACT → FINALIZE',
  );
  for (const phase of DELIVERY_ANALYSIS_PHASE_ORDER) {
    const packet = DELIVERY_ANALYSIS_WORKFLOW[phase];
    assert.ok(packet.title);
    assert.ok(packet.objective);
    assert.ok(packet.required);
    assert.ok(packet.prohibited);
    assert.ok(packet.commands.length);
    assert.equal(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases[phase].completeCommand, 'phase complete');
    assert.ok(DELIVERY_ANALYSIS_COMMAND_CHAIN.phases[phase].commands.includes('phase complete'));
    assert.equal(packet.completeCommand, 'phase complete');
    assert.equal('submit' in packet, false);
  }
  assert.deepEqual(deliveryAnalysisNormalCommandPath(), [
    'status',
    'delivery-unit current',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
  ]);
  assert.match(DELIVERY_ANALYSIS_WORKFLOW.answer_review.objective, /HUMAN、上游、项目证据与 Agent/);
  assert.match(DELIVERY_ANALYSIS_WORKFLOW.answer_review.prohibited, /回到 PROPOSE/);
});
