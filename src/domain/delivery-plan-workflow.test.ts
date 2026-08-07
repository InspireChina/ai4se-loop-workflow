import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERY_PLAN_PHASE_ORDER,
  DELIVERY_PLAN_PHASE_SEQUENCE,
  DELIVERY_PLAN_WORKFLOW,
  deliveryPlanNormalCommandPath,
} from './delivery-plan-workflow';

test('defines the Delivery Plan phase order and work packets in one catalog', () => {
  assert.deepEqual(DELIVERY_PLAN_PHASE_ORDER, [
    'planning_basis', 'delivery_units', 'coverage_order', 'finalize',
  ]);
  assert.equal(
    DELIVERY_PLAN_PHASE_SEQUENCE,
    'PLANNING BASIS → DELIVERY UNITS → COVERAGE & ORDER → FINALIZE',
  );
  for (const phase of DELIVERY_PLAN_PHASE_ORDER) {
    const packet = DELIVERY_PLAN_WORKFLOW[phase];
    assert.ok(packet.title);
    assert.ok(packet.objective);
    assert.ok(packet.required);
    assert.ok(packet.prohibited);
    assert.ok(packet.commands.length);
    assert.ok(packet.reviewBeforeSubmit.length);
    assert.match(packet.submit, /^delivery-plan /);
  }
  assert.deepEqual(deliveryPlanNormalCommandPath(), [
    'delivery-plan basis complete',
    'delivery-plan units complete',
    'delivery-plan coverage complete',
    'delivery-plan validate',
    'delivery-plan complete',
  ]);
});
