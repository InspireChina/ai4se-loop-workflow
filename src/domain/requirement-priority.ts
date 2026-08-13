export const REQUIREMENT_PRIORITY_VALUES = ['9', '8', '7', '6', '5', '4', '3', '2', '1'] as const;

export type RequirementPriority = typeof REQUIREMENT_PRIORITY_VALUES[number];

export const DEFAULT_REQUIREMENT_PRIORITY: RequirementPriority = '5';

export const REQUIREMENT_PRIORITY_OPTIONS: readonly {
  value: RequirementPriority;
  label: string;
}[] = REQUIREMENT_PRIORITY_VALUES.map((value) => ({
  value,
  label: value === '9' ? '9 · 最高' : value === '1' ? '1 · 最低' : value,
}));

const legacyPriority: Record<string, RequirementPriority> = {
  P0: '9',
  S0: '9',
  P1: '9',
  S1: '9',
  P2: '5',
  S2: '5',
  P3: '1',
  S3: '1',
};

export function requirementPriority(input: unknown): RequirementPriority {
  const value = String(input ?? '').trim();
  if ((REQUIREMENT_PRIORITY_VALUES as readonly string[]).includes(value)) return value as RequirementPriority;
  throw new Error('优先级只能选择 1 到 9，9 为最高优先级');
}

export function normalizedRequirementPriority(input: string | null | undefined): RequirementPriority | null {
  const value = String(input ?? '').trim().toUpperCase();
  if ((REQUIREMENT_PRIORITY_VALUES as readonly string[]).includes(value)) return value as RequirementPriority;
  return legacyPriority[value] || null;
}

export function requirementPriorityRank(input: string | null | undefined) {
  return Number(normalizedRequirementPriority(input) || 0);
}

export function requirementPriorityLabel(input: string | null | undefined) {
  return normalizedRequirementPriority(input) || '未设置';
}
