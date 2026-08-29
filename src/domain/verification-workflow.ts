import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const VERIFICATION_COMMAND_CHAIN = loadCommandChainDefinition('verification');

export const VERIFICATION_PHASE_ORDER = Object.keys(VERIFICATION_COMMAND_CHAIN.phases) as (
  | 'inputs'
  | 'plan'
  | 'execute'
  | 'evidence_review'
  | 'finalize'
)[];

export type VerificationPhase = typeof VERIFICATION_PHASE_ORDER[number];

export const VERIFICATION_WORKFLOW = VERIFICATION_COMMAND_CHAIN.phases as Record<
  VerificationPhase,
  CommandChainPhaseDefinition
>;

export const VERIFICATION_PHASE_SEQUENCE = VERIFICATION_PHASE_ORDER
  .map((phase) => VERIFICATION_WORKFLOW[phase].title)
  .join(' → ');

export function verificationNormalCommandPath() {
  return ['status', ...VERIFICATION_PHASE_ORDER.map(() => 'phase complete')];
}
