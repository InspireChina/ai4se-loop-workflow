import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export const DEVELOPMENT_COMMAND_CHAIN = loadCommandChainDefinition('development');

export const DEVELOPMENT_PHASE_ORDER = Object.keys(DEVELOPMENT_COMMAND_CHAIN.phases) as (
  | 'delivery_spec'
  | 'implement'
  | 'review'
  | 'developer_verify'
  | 'commit'
  | 'finalize'
)[];

export type DevelopmentPhase = typeof DEVELOPMENT_PHASE_ORDER[number];

export const DEVELOPMENT_WORKFLOW = DEVELOPMENT_COMMAND_CHAIN.phases as Record<
  DevelopmentPhase,
  CommandChainPhaseDefinition
>;

export const DEVELOPMENT_PHASE_SEQUENCE = DEVELOPMENT_PHASE_ORDER
  .map((phase) => DEVELOPMENT_WORKFLOW[phase].title)
  .join(' → ');

export function developmentNormalCommandPath() {
  return [
    'status',
    'delivery-spec current',
    ...DEVELOPMENT_PHASE_ORDER.map(() => 'phase complete'),
  ];
}
