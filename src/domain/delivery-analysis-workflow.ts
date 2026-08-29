import { loadCommandChainDefinition } from './command-chain-definition';
import type { CommandChainPhaseDefinition } from './command-chain-definition';

export type DeliveryAnalysisPhase =
  | 'delivery_unit'
  | 'impact_scan'
  | 'decision_proposal'
  | 'decision_resolution'
  | 'answer_review'
  | 'delivery_contract'
  | 'finalize';

export const DELIVERY_ANALYSIS_COMMAND_CHAIN = loadCommandChainDefinition('delivery-analysis');
const COMMAND_CHAIN = DELIVERY_ANALYSIS_COMMAND_CHAIN;
const DELIVERY_ANALYSIS_PHASES = new Set<DeliveryAnalysisPhase>([
  'delivery_unit',
  'impact_scan',
  'decision_proposal',
  'decision_resolution',
  'answer_review',
  'delivery_contract',
  'finalize',
]);
const yamlPhaseOrder = Object.keys(COMMAND_CHAIN.phases);

if (yamlPhaseOrder.length !== DELIVERY_ANALYSIS_PHASES.size
  || yamlPhaseOrder.some((phase) => !DELIVERY_ANALYSIS_PHASES.has(phase as DeliveryAnalysisPhase))) {
  throw new Error('交付分析命令链 YAML 的 phases 与当前领域状态模型不一致');
}

export const DELIVERY_ANALYSIS_PHASE_ORDER = yamlPhaseOrder as DeliveryAnalysisPhase[];

export const DELIVERY_ANALYSIS_WORKFLOW = Object.fromEntries(
  DELIVERY_ANALYSIS_PHASE_ORDER.map((phase) => [phase, COMMAND_CHAIN.phases[phase]]),
) as Record<DeliveryAnalysisPhase, CommandChainPhaseDefinition>;
export const DELIVERY_ANALYSIS_PHASE_SEQUENCE = DELIVERY_ANALYSIS_PHASE_ORDER
  .map((phase) => COMMAND_CHAIN.phases[phase].title)
  .join(' → ');

export const DELIVERY_ANALYSIS_AGENT = COMMAND_CHAIN.agent;
export const DELIVERY_ANALYSIS_TERMINAL_ACTIONS = ['phase complete'];

export function deliveryAnalysisNormalCommandPath() {
  return [
    'status',
    'delivery-unit current',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
    'phase complete',
  ];
}
