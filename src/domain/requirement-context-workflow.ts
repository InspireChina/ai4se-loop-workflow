import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const REQUIREMENT_CONTEXT_COMMAND_CHAIN = loadCommandChainDefinition('requirement-context');

export const REQUIREMENT_CONTEXT_PHASE_ORDER = Object.keys(REQUIREMENT_CONTEXT_COMMAND_CHAIN.phases) as (
  | 'as_is'
  | 'decision_proposal'
  | 'decision_resolution'
  | 'answer_review'
  | 'to_be'
  | 'impact_scan'
  | 'scope'
  | 'acceptance'
  | 'finalize'
)[];

export type RequirementContextPhase = typeof REQUIREMENT_CONTEXT_PHASE_ORDER[number];

export const REQUIREMENT_CONTEXT_WORKFLOW = REQUIREMENT_CONTEXT_COMMAND_CHAIN.phases as Record<
  RequirementContextPhase,
  CommandChainPhaseDefinition
>;

export const REQUIREMENT_CONTEXT_PHASE_SEQUENCE = REQUIREMENT_CONTEXT_PHASE_ORDER
  .map((phase) => REQUIREMENT_CONTEXT_WORKFLOW[phase].title)
  .join(' → ');

export function requirementContextNormalCommandPath() {
  return [
    'status',
    ...REQUIREMENT_CONTEXT_PHASE_ORDER.map(() => 'phase complete'),
  ];
}
