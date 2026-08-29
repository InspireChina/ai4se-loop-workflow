import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const FEEDBACK_TRIAGE_COMMAND_CHAIN = loadCommandChainDefinition('feedback-triage');
export const FEEDBACK_VERIFY_COMMAND_CHAIN = loadCommandChainDefinition('feedback-verify');

export const FEEDBACK_TRIAGE_PHASE_ORDER = Object.keys(FEEDBACK_TRIAGE_COMMAND_CHAIN.phases);
export const FEEDBACK_VERIFY_PHASE_ORDER = Object.keys(FEEDBACK_VERIFY_COMMAND_CHAIN.phases);

export const FEEDBACK_TRIAGE_WORKFLOW = FEEDBACK_TRIAGE_COMMAND_CHAIN.phases as Record<string, CommandChainPhaseDefinition>;
export const FEEDBACK_VERIFY_WORKFLOW = FEEDBACK_VERIFY_COMMAND_CHAIN.phases as Record<string, CommandChainPhaseDefinition>;

export function feedbackTriageNormalCommandPath() {
  return ['status', ...FEEDBACK_TRIAGE_PHASE_ORDER.map(() => 'phase complete')];
}

export function feedbackVerifyNormalCommandPath() {
  return ['status', ...FEEDBACK_VERIFY_PHASE_ORDER.map(() => 'phase complete')];
}
