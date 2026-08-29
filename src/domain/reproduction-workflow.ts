import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const REPRODUCTION_COMMAND_CHAIN = loadCommandChainDefinition('reproduction');

export const REPRODUCTION_PHASE_ORDER = Object.keys(REPRODUCTION_COMMAND_CHAIN.phases) as (
  | 'investigation'
  | 'alignment_proposal'
  | 'alignment_resolution'
  | 'answer_review'
  | 'finalize'
)[];

export type ReproductionPhase = typeof REPRODUCTION_PHASE_ORDER[number];

export const REPRODUCTION_WORKFLOW = REPRODUCTION_COMMAND_CHAIN.phases as Record<
  ReproductionPhase,
  CommandChainPhaseDefinition
>;

export const REPRODUCTION_PHASE_SEQUENCE = REPRODUCTION_PHASE_ORDER
  .map((phase) => REPRODUCTION_WORKFLOW[phase].title)
  .join(' → ');

export function reproductionNormalCommandPath() {
  return ['status', ...REPRODUCTION_PHASE_ORDER.map(() => 'phase complete')];
}
