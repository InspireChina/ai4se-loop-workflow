import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const REVIEW_COMMAND_CHAIN = loadCommandChainDefinition('review');

export const REVIEW_PHASE_ORDER = Object.keys(REVIEW_COMMAND_CHAIN.phases) as (
  | 'inputs'
  | 'fact_reconciliation'
  | 'closure_assessment'
  | 'closure_output'
  | 'finalize'
)[];

export type ReviewPhase = typeof REVIEW_PHASE_ORDER[number];

export const REVIEW_WORKFLOW = REVIEW_COMMAND_CHAIN.phases as Record<
  ReviewPhase,
  CommandChainPhaseDefinition
>;

export const REVIEW_PHASE_SEQUENCE = REVIEW_PHASE_ORDER
  .map((phase) => REVIEW_WORKFLOW[phase].title)
  .join(' → ');

export function reviewNormalCommandPath() {
  return ['status', ...REVIEW_PHASE_ORDER.map(() => 'phase complete')];
}
