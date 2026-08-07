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
}] as const;

export type RequirementMetadataKey = typeof REQUIREMENT_METADATA_DEFINITIONS[number]['key'];

export type RequirementMetadataInput = {
  key: RequirementMetadataKey;
  value: string;
};

const definitionByKey = new Map<string, typeof REQUIREMENT_METADATA_DEFINITIONS[number]>(
  REQUIREMENT_METADATA_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function requirementMetadataDefinition(key: string) {
  return definitionByKey.get(key);
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
    metadata.push({ key: definition.key, value });
  }

  return metadata;
}
