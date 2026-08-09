export const REQUIREMENT_METADATA_DEFINITIONS = [{
  key: 'source.reference_url',
  label: '参考链接',
  inputType: 'url',
  placeholder: 'https://...',
}, {
  key: 'tracking.requirement_card_id',
  label: '需求卡号',
  inputType: 'text',
  placeholder: '例如：REQ-1234',
}, {
  key: 'workflow.analysis_decision_mode',
  label: 'Agent 自动决策强度',
  inputType: 'select',
  placeholder: '',
  options: [{
    value: 'conservative',
    label: '审慎对齐',
  }, {
    value: 'balanced',
    label: '平衡',
  }, {
    value: 'autonomous',
    label: '高度自主',
  }, {
    value: 'fully_autonomous',
    label: '完全自主',
  }],
}] as const;

export type RequirementMetadataKey = typeof REQUIREMENT_METADATA_DEFINITIONS[number]['key'];

export type RequirementMetadataInput = {
  key: RequirementMetadataKey;
  value: string;
};

export const DEFAULT_ANALYSIS_DECISION_MODE = 'balanced' as const;
export type AnalysisDecisionMode = 'conservative' | 'balanced' | 'autonomous' | 'fully_autonomous';

const definitionByKey = new Map<string, typeof REQUIREMENT_METADATA_DEFINITIONS[number]>(
  REQUIREMENT_METADATA_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function requirementMetadataDefinition(key: string) {
  return definitionByKey.get(key);
}

export function analysisDecisionMode(entries: readonly { metadata_key?: string; key?: string; metadata_value?: string; value?: string }[]): AnalysisDecisionMode {
  const entry = entries.find((item) => (item.metadata_key || item.key) === 'workflow.analysis_decision_mode');
  const value = entry?.metadata_value || entry?.value;
  return value === 'conservative'
    || value === 'balanced'
    || value === 'autonomous'
    || value === 'fully_autonomous'
    ? value
    : DEFAULT_ANALYSIS_DECISION_MODE;
}

export const workflowDecisionMode = analysisDecisionMode;
export type WorkflowDecisionMode = AnalysisDecisionMode;

export function requirementMetadataValueLabel(key: string, value: string) {
  const definition = requirementMetadataDefinition(key);
  if (!definition || definition.inputType !== 'select') return value;
  return definition.options.find((option) => option.value === value)?.label || value;
}

export function parseRequirementMetadata(entries: readonly { key: unknown; value: unknown }[]): RequirementMetadataInput[] {
  const metadata: RequirementMetadataInput[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = String(entry.key || '').trim();
    const value = String(entry.value || '').trim();
    if (!key && !value) continue;
    const definition = requirementMetadataDefinition(key);
    if (!definition) throw new Error(`不支持的 metadata key：${key || '空值'}`);
    if (seen.has(key)) throw new Error(`metadata 不能重复添加：${definition.label}`);
    seen.add(key);
    if (!value) continue;
    if (value.length > 2000) throw new Error(`${definition.label}不能超过 2000 个字符`);
    if (definition.inputType === 'url') {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`${definition.label}必须是有效 URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${definition.label}只支持 HTTP 或 HTTPS URL`);
      }
    }
    if (definition.inputType === 'select'
      && !definition.options.some((option) => option.value === value)) {
      throw new Error(`${definition.label}的值不受支持`);
    }
    metadata.push({ key: definition.key, value });
  }

  return metadata;
}
