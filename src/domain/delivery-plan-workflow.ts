import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const DELIVERY_PLAN_COMMAND_CHAIN = loadCommandChainDefinition('delivery-plan');

export const DELIVERY_PLAN_PHASE_ORDER = Object.keys(DELIVERY_PLAN_COMMAND_CHAIN.phases) as (
  | 'inputs'
  | 'planning_basis'
  | 'delivery_units'
  | 'coverage_order'
  | 'finalize'
)[];

export type DeliveryPlanPhase = typeof DELIVERY_PLAN_PHASE_ORDER[number];

export const DELIVERY_PLAN_WORKFLOW = DELIVERY_PLAN_COMMAND_CHAIN.phases as Record<
  DeliveryPlanPhase,
  CommandChainPhaseDefinition
>;

export const DELIVERY_PLAN_PHASE_SEQUENCE = DELIVERY_PLAN_PHASE_ORDER
  .map((phase) => DELIVERY_PLAN_WORKFLOW[phase].title)
  .join(' → ');

export function deliveryPlanNormalCommandPath() {
  return ['status', ...DELIVERY_PLAN_PHASE_ORDER.map(() => 'phase complete')];
}
