import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { agentCommandChainCatalog, commandChainCatalogItem, COMMAND_CHAIN_CATALOG } from '../domain/command-chain-catalog';
import { parseCommandChainDefinition } from '../domain/command-chain-definition';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { bundledCommandChainYaml, hasBundledCommandChainYaml, type BundledCommandChainConfiguration } from '../infrastructure/agent-configuration-store';
import { appDatabaseConnection, hash } from '../infrastructure/database';

export type AgentConfigurationDocument = {
  commandChainId: string;
  label: string;
  yaml: string;
  revision: number;
  updatedAt: string;
  validationError: string | null;
};

export type AgentConfigurationSet = {
  configurationId: string;
  agentId: FlowAgentId;
  name: string;
  active: boolean;
  builtinKey: 'default' | 'openspec' | null;
  contextAdapter: 'openspec' | null;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  promptRevision: number;
  promptSource: 'system' | 'human' | 'evolution';
  promptReason: string | null;
  promptTemplateVersion: number;
  documents: AgentConfigurationDocument[];
};

export type AgentConfigurationPromptCandidate = {
  candidate_id: string;
  agent_id: FlowAgentId;
  configuration_id: string;
  revision: number;
  base_prompt_revision: number;
  content: string;
  content_hash: string;
  source: 'evolution';
  reason: string | null;
  evidence_json: string | null;
  remaining_runs: number;
  created_at: string;
  updated_at: string;
  status: 'candidate';
};

type ConfigurationRow = {
  configuration_id: string;
  agent_id: FlowAgentId;
  name: string;
  is_active: number;
  builtin_key: 'default' | 'openspec' | null;
  context_adapter: 'openspec' | null;
  created_at: string;
  updated_at: string;
  prompt_content: string;
  prompt_revision: number;
  prompt_source: 'system' | 'human' | 'evolution';
  prompt_reason: string | null;
  prompt_template_version: number;
};

type DocumentRow = {
  configuration_id: string;
  command_chain_id: string;
  yaml_content: string;
  revision: number;
  updated_at: string;
};

const nameSchema = z.string().trim().min(1, '配置名称不能为空').max(80, '配置名称不能超过 80 个字符');
const yamlSchema = z.string().trim().min(1, 'YAML 不能为空').max(200_000, 'YAML 不能超过 200000 个字符');

let seedsEnsured = false;

function ensureBuiltinAgentConfiguration(
  db: ReturnType<typeof appDatabaseConnection>,
  agentId: FlowAgentId,
  builtinKey: BundledCommandChainConfiguration,
) {
  const catalog = agentCommandChainCatalog(agentId).filter((item) => (
    builtinKey === 'default' || hasBundledCommandChainYaml(item.id, builtinKey)
  ));
  if (!catalog.length && builtinKey === 'openspec') return null;
  const name = builtinKey === 'default' ? '默认配置' : 'OpenSpec';
  let configuration = db.prepare(`
    SELECT configuration_id FROM agent_configuration_sets
    WHERE agent_id = ? AND builtin_key = ?
  `).get(agentId, builtinKey) as { configuration_id: string } | undefined;
  if (!configuration) {
    const named = builtinKey === 'default' ? db.prepare(`
      SELECT configuration_id FROM agent_configuration_sets
      WHERE agent_id = ? AND name = ? AND builtin_key IS NULL
    `).get(agentId, name) as { configuration_id: string } | undefined : undefined;
    const configurationId = named?.configuration_id || randomUUID();
    if (named) {
      db.prepare(`UPDATE agent_configuration_sets SET builtin_key = ?, context_adapter = ? WHERE configuration_id = ?`)
        .run(builtinKey, builtinKey === 'openspec' ? 'openspec' : null, configurationId);
    } else {
      const hasActive = db.prepare(`SELECT 1 FROM agent_configuration_sets WHERE agent_id = ? AND is_active = 1`).get(agentId);
      const prompt = '';
      const storedName = builtinKey === 'openspec' && db.prepare(`
        SELECT 1 FROM agent_configuration_sets WHERE agent_id = ? AND name = ?
      `).get(agentId, name) ? 'OpenSpec（内置）' : name;
      db.prepare(`
        INSERT INTO agent_configuration_sets(
          configuration_id, agent_id, name, is_active, builtin_key, context_adapter,
          prompt_content, prompt_hash, prompt_source, prompt_reason, prompt_template_version
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)
      `).run(
        configurationId, agentId, storedName, builtinKey === 'default' && !hasActive ? 1 : 0,
        builtinKey, builtinKey === 'openspec' ? 'openspec' : null,
        prompt, hash(prompt), `系统模板 V${AGENT_PROMPT_SEED_REVISION}`, AGENT_PROMPT_SEED_REVISION,
      );
    }
    configuration = { configuration_id: configurationId };
  }
  for (const item of catalog) {
    const yaml = bundledCommandChainYaml(item.id, builtinKey);
    db.prepare(`
      INSERT OR IGNORE INTO agent_configuration_documents(
        configuration_id, command_chain_id, yaml_content, content_hash, system_managed
      ) VALUES(?, ?, ?, ?, 1)
    `).run(configuration.configuration_id, item.id, yaml, hash(yaml));
    db.prepare(`
      UPDATE agent_configuration_documents
      SET yaml_content = ?, content_hash = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE configuration_id = ? AND command_chain_id = ? AND system_managed = 1 AND content_hash <> ?
    `).run(yaml, hash(yaml), configuration.configuration_id, item.id, hash(yaml));
  }
  return configuration.configuration_id;
}

export function ensureAgentConfigurationSeeds() {
  if (seedsEnsured) return;
  const db = appDatabaseConnection();
  db.transaction(() => {
    for (const agentId of FLOW_AGENT_IDS) {
      const defaultId = ensureBuiltinAgentConfiguration(db, agentId, 'default');
      ensureBuiltinAgentConfiguration(db, agentId, 'openspec');
      const active = db.prepare(`SELECT 1 FROM agent_configuration_sets WHERE agent_id = ? AND is_active = 1`).get(agentId);
      if (!active && defaultId) {
        db.prepare(`UPDATE agent_configuration_sets SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE configuration_id = ?`).run(defaultId);
      }
    }
  })();
  seedsEnsured = true;
}

export function activeAgentConfigurationPrompt(agentId: FlowAgentId) {
  ensureAgentConfigurationSeeds();
  const row = appDatabaseConnection().prepare(`
    SELECT configuration_id, prompt_content, prompt_hash, prompt_revision,
           prompt_source, prompt_reason, prompt_template_version, updated_at
    FROM agent_configuration_sets
    WHERE agent_id = ? AND is_active = 1
  `).get(agentId) as {
    configuration_id: string;
    prompt_content: string;
    prompt_hash: string;
    prompt_revision: number;
    prompt_source: 'system' | 'human' | 'evolution';
    prompt_reason: string | null;
    prompt_template_version: number;
    updated_at: string;
  } | undefined;
  if (!row) throw new Error(`Agent 当前配置不存在：${agentId}`);
  return {
    configurationId: row.configuration_id,
    content: row.prompt_content,
    contentHash: row.prompt_hash || hash(row.prompt_content),
    revision: row.prompt_revision,
    source: row.prompt_source,
    reason: row.prompt_reason,
    templateVersion: row.prompt_template_version,
    updatedAt: row.updated_at,
  };
}

export function activeAgentConfigurationPromptCandidate(agentId: FlowAgentId): AgentConfigurationPromptCandidate | null {
  return null;
}

export function isActiveAgentConfigurationPromptCandidate(agentIdInput: string, candidateId: string) {
  return isFlowAgentId(agentIdInput)
    && activeAgentConfigurationPromptCandidate(agentIdInput)?.candidate_id === candidateId;
}

export function createAgentConfigurationPromptCandidate(input: {
  agentId: FlowAgentId;
  content: string;
  reason: string;
  evidence: unknown;
}) {
  return null as AgentConfigurationPromptCandidate | null;
}

export function syncAgentConfigurationCanaryReceipts(input: {
  agentId: FlowAgentId;
  receipts: { executionId: string; outcome: 'active' | 'succeeded' | 'failed' | 'ignored' }[];
}) {
  return { status: 'none' as const, fingerprint: '' };
}

function configurationSets(agentId: FlowAgentId): AgentConfigurationSet[] {
  ensureAgentConfigurationSeeds();
  const db = appDatabaseConnection();
  const rows = db.prepare(`
    SELECT * FROM agent_configuration_sets WHERE agent_id = ?
    ORDER BY is_active DESC, updated_at DESC, name
  `).all(agentId) as ConfigurationRow[];
  const documents = db.prepare(`
    SELECT document.* FROM agent_configuration_documents document
    JOIN agent_configuration_sets configuration ON configuration.configuration_id = document.configuration_id
    WHERE configuration.agent_id = ?
    ORDER BY document.command_chain_id
  `).all(agentId) as DocumentRow[];
  const catalog = new Map<string, (typeof COMMAND_CHAIN_CATALOG)[number]>(
    agentCommandChainCatalog(agentId).map((item) => [item.id, item]),
  );
  return rows.map((row) => ({
    configurationId: row.configuration_id,
    agentId: row.agent_id,
    name: row.name,
    active: Boolean(row.is_active),
    builtinKey: row.builtin_key,
    contextAdapter: row.context_adapter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    prompt: row.prompt_content,
    promptRevision: row.prompt_revision,
    promptSource: row.prompt_source,
    promptReason: row.prompt_reason,
    promptTemplateVersion: row.prompt_template_version,
    documents: documents.filter((document) => document.configuration_id === row.configuration_id).map((document) => ({
      commandChainId: document.command_chain_id,
      label: catalog.get(document.command_chain_id)?.label || document.command_chain_id,
      yaml: document.yaml_content,
      revision: document.revision,
      updatedAt: document.updated_at,
      validationError: (() => {
        try {
          parseCommandChainDefinition(document.command_chain_id, document.yaml_content);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
    })),
  }));
}

export function listAgentConfigurations(agentIdInput: string) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  return configurationSets(agentIdInput);
}

export function activeAgentConfigurationContextAdapter(agentIdInput: string) {
  if (!isFlowAgentId(agentIdInput)) return null;
  ensureAgentConfigurationSeeds();
  const row = appDatabaseConnection().prepare(`
    SELECT context_adapter FROM agent_configuration_sets
    WHERE agent_id = ? AND is_active = 1
  `).get(agentIdInput) as { context_adapter: string | null } | undefined;
  return row?.context_adapter === 'openspec' ? 'openspec' : null;
}

export function createAgentConfiguration(input: { agentId: string; name: unknown; fromConfigurationId?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const catalog = agentCommandChainCatalog(input.agentId);
  const name = nameSchema.parse(input.name);
  const sourceId = String(input.fromConfigurationId || '');
  const db = appDatabaseConnection();
  ensureAgentConfigurationSeeds();
  const configurationId = randomUUID();
  db.transaction(() => {
    const sourceConfiguration = sourceId ? db.prepare(`
      SELECT prompt_content, prompt_revision, prompt_source, prompt_reason, prompt_template_version, context_adapter
      FROM agent_configuration_sets WHERE configuration_id = ? AND agent_id = ?
    `).get(sourceId, input.agentId) as Pick<ConfigurationRow,
      'prompt_content' | 'prompt_revision' | 'prompt_source' | 'prompt_reason' | 'prompt_template_version' | 'context_adapter'
    > | undefined : undefined;
    const prompt = '';
    db.prepare(`
      INSERT INTO agent_configuration_sets(
        configuration_id, agent_id, name, context_adapter, prompt_content, prompt_hash, prompt_revision,
        prompt_source, prompt_reason, prompt_template_version
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      configurationId,
      input.agentId,
      name,
      sourceConfiguration?.context_adapter || null,
      prompt,
      hash(prompt),
      sourceConfiguration?.prompt_revision || 1,
      sourceConfiguration?.prompt_source || 'system',
      sourceConfiguration?.prompt_reason || `系统模板 V${AGENT_PROMPT_SEED_REVISION}`,
      sourceConfiguration?.prompt_template_version || AGENT_PROMPT_SEED_REVISION,
    );
    for (const item of catalog) {
      const source = sourceId ? db.prepare(`
        SELECT document.yaml_content FROM agent_configuration_documents document
        JOIN agent_configuration_sets configuration ON configuration.configuration_id = document.configuration_id
        WHERE document.configuration_id = ? AND configuration.agent_id = ? AND document.command_chain_id = ?
      `).get(sourceId, input.agentId, item.id) as { yaml_content: string } | undefined : undefined;
      const yaml = source?.yaml_content || bundledCommandChainYaml(item.id);
      db.prepare(`
        INSERT INTO agent_configuration_documents(configuration_id, command_chain_id, yaml_content, content_hash)
        VALUES(?, ?, ?, ?)
      `).run(configurationId, item.id, yaml, hash(yaml));
    }
  })();
  revalidateAgent(input.agentId);
  return configurationId;
}

export function saveActiveAgentConfigurationPrompt(input: {
  agentId: string;
  content: unknown;
  source?: 'system' | 'human' | 'evolution';
  reason?: string | null;
  templateVersion?: number;
}) {
  throw new Error('Agent Prompt 只从当前工作目录的 .omp/agents 加载，不能在内部保存');
}

export function renameAgentConfiguration(input: { agentId: string; configurationId: unknown; name: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const name = nameSchema.parse(input.name);
  const result = appDatabaseConnection().prepare(`
    UPDATE agent_configuration_sets SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE configuration_id = ? AND agent_id = ?
  `).run(name, String(input.configurationId), input.agentId);
  if (!result.changes) throw new Error('Agent 配置不存在');
  revalidateAgent(input.agentId);
}

export function activateAgentConfiguration(input: { agentId: string; configurationId: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const configurationId = String(input.configurationId);
  const db = appDatabaseConnection();
  const documents = db.prepare(`
    SELECT command_chain_id, yaml_content FROM agent_configuration_documents
    WHERE configuration_id = ?
  `).all(configurationId) as { command_chain_id: string; yaml_content: string }[];
  for (const document of documents) parseCommandChainDefinition(document.command_chain_id, document.yaml_content);
  db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM agent_configuration_sets WHERE configuration_id = ? AND agent_id = ?`).get(configurationId, input.agentId);
    if (!exists) throw new Error('Agent 配置不存在');
    db.prepare(`DELETE FROM agent_configuration_prompt_candidates WHERE agent_id = ?`).run(input.agentId);
    db.prepare(`UPDATE agent_configuration_sets SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?`).run(input.agentId);
    db.prepare(`UPDATE agent_configuration_sets SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE configuration_id = ?`).run(configurationId);
  })();
  revalidateAgent(input.agentId);
}

export function deleteAgentConfiguration(input: { agentId: string; configurationId: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const configurationId = String(input.configurationId);
  const db = appDatabaseConnection();
  const row = db.prepare(`SELECT is_active, builtin_key FROM agent_configuration_sets WHERE configuration_id = ? AND agent_id = ?`).get(configurationId, input.agentId) as { is_active: number; builtin_key: string | null } | undefined;
  if (!row) throw new Error('Agent 配置不存在');
  if (row.is_active) throw new Error('不能删除当前生效配置，请先启用另一套配置');
  if (row.builtin_key) throw new Error('内置配置不能删除；可以复制后编辑自定义版本');
  db.prepare(`DELETE FROM agent_configuration_sets WHERE configuration_id = ?`).run(configurationId);
  revalidateAgent(input.agentId);
}

export function saveAgentConfigurationDocument(input: { agentId: string; configurationId: unknown; commandChainId: unknown; yaml: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const configurationId = String(input.configurationId);
  const commandChainId = String(input.commandChainId);
  const item = commandChainCatalogItem(commandChainId);
  if (!item || item.agentId !== input.agentId) throw new Error('命令链不属于当前 Agent');
  const yaml = yamlSchema.parse(input.yaml).trimEnd() + '\n';
  parseCommandChainDefinition(commandChainId, yaml);
  const db = appDatabaseConnection();
  const result = db.prepare(`
    UPDATE agent_configuration_documents
    SET yaml_content = ?, content_hash = ?, revision = revision + 1,
        system_managed = 0, updated_at = CURRENT_TIMESTAMP
    WHERE configuration_id = ? AND command_chain_id = ?
      AND EXISTS (
        SELECT 1 FROM agent_configuration_sets configuration
        WHERE configuration.configuration_id = agent_configuration_documents.configuration_id
          AND configuration.agent_id = ?
      )
  `).run(yaml, hash(yaml), configurationId, commandChainId, input.agentId);
  if (!result.changes) throw new Error('Agent 配置文档不存在');
  db.prepare(`UPDATE agent_configuration_sets SET updated_at = CURRENT_TIMESTAMP WHERE configuration_id = ?`).run(configurationId);
  revalidateAgent(input.agentId);
  return parseCommandChainDefinition(commandChainId, yaml);
}

function revalidateAgent(agentId: string) {
  try {
    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}`);
  } catch { /* non-request usage */ }
}

export const agentConfigurationInternals = { bundledYaml: bundledCommandChainYaml };
