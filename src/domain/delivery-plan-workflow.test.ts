import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERY_PLAN_COMMAND_CHAIN,
  DELIVERY_PLAN_PHASE_ORDER,
  DELIVERY_PLAN_PHASE_SEQUENCE,
  DELIVERY_PLAN_WORKFLOW,
  deliveryPlanNormalCommandPath,
} from './delivery-plan-workflow';

test('loads Delivery Plan entirely from YAML', () => {
  assert.deepEqual(DELIVERY_PLAN_PHASE_ORDER, [
    'inputs', 'planning_basis', 'delivery_units', 'coverage_order', 'finalize',
  ]);
  assert.equal(
    DELIVERY_PLAN_PHASE_SEQUENCE,
    'FROZEN PLAN INPUTS → PLANNING BASIS → DELIVERY UNITS → COVERAGE ORDER → FINALIZE',
  );
  assert.equal(DELIVERY_PLAN_WORKFLOW.inputs.builtin, 'delivery-plan-inputs');
  assert.equal(DELIVERY_PLAN_WORKFLOW.finalize.builtin, 'delivery-plan-finalize');
  assert.equal(DELIVERY_PLAN_COMMAND_CHAIN.artifacts['delivery-plan'].blocks.sources.writable, false);
  assert.deepEqual(deliveryPlanNormalCommandPath(), [
    'status',
    'phase complete', 'phase complete', 'phase complete', 'phase complete', 'phase complete',
  ]);
});

test('declares units and coverage as generic Artifact blocks', () => {
  assert.deepEqual(DELIVERY_PLAN_WORKFLOW.delivery_units.artifactBlocks, [
    { artifactId: 'delivery-plan', blockId: 'units' },
  ]);
  assert.deepEqual(DELIVERY_PLAN_WORKFLOW.coverage_order.artifactBlocks, [
    { artifactId: 'delivery-plan', blockId: 'units' },
    { artifactId: 'delivery-plan', blockId: 'coverage' },
    { artifactId: 'delivery-plan', blockId: 'ordering' },
  ]);
});
