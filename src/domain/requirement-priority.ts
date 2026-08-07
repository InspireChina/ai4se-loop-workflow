export type RequirementPriority = 'P1' | 'P2' | 'P3';

export const REQUIREMENT_PRIORITY_OPTIONS: readonly {
  value: RequirementPriority;
  label: string;
}[] = [{
  value: 'P1',
  label: '高',
}, {
  value: 'P2',
  label: '中',
}, {
  value: 'P3',
  label: '低',
}];

export function requirementPriority(input: unknown): RequirementPriority {
  if (input === 'P1' || input === 'P2' || input === 'P3') return input;
  throw new Error('优先级只能选择高、中或低');
}

export function requirementPriorityLabel(priority: string | null | undefined) {
  const normalized = String(priority || '').toUpperCase();
  if (normalized === 'P1' || normalized === 'S1') return '高';
  if (normalized === 'P2' || normalized === 'S2') return '中';
  if (normalized === 'P3' || normalized === 'S3') return '低';
  if (normalized === 'P0' || normalized === 'S0') return '紧急';
  return '未定级';
}
