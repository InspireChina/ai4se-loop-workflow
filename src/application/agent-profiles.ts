import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, DEFAULT_AGENT_MEMORY, FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { databaseConnection, hash, paths } from '../infrastructure/database';

export type AgentProfile = {
  agent_id: FlowAgentId;
  display_name: string;
  prompt_seed_revision: number;
  auto_evolve: number;
  current_prompt_version: number;
  current_memory_revision: number;
  candidate_prompt_version: number | null;
  canary_remaining: number;
  last_evolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PromptVersion = {
  agent_id: FlowAgentId;
  version: number;
  content: string;
  content_hash: string;
  status: 'active' | 'candidate' | 'superseded' | 'rolled_back';
  source: 'seed' | 'human' | 'local' | 'evolution';
  reason: string | null;
  evidence_json: string | null;
  created_at: string;
};

export type MemoryVersion = {
  agent_id: FlowAgentId;
  revision: number;
  content: string;
  content_hash: string;
  source: 'seed' | 'human' | 'local' | 'evolution';
  reason: string | null;
  evidence_json: string | null;
  created_at: string;
};

export type AgentRuntimeContext = {
  agentId: FlowAgentId;
  prompt: string;
  promptVersion: number;
  promptHash: string;
  promptStatus: 'active' | 'candidate';
  evolutionCandidateId: string | null;
  memory: string;
  memoryRevision: number;
  memoryHash: string;
  recentMemory: string;
};

export type AgentObservation = {
  observation_id: string;
  agent_id: FlowAgentId;
  fingerprint: string;
  category: string;
  summary: string;
  guidance: string;
  target: 'daily' | 'memory' | 'prompt';
  confidence: number;
  status: 'observed' | 'promoted_memory' | 'prompt_candidate' | 'promoted_prompt' | 'rejected';
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

const promptSchema = z.string().trim().min(20).max(20_000);
const memorySchema = z.string().trim().max(40_000);

export function agentRuntimeRoot() {
  return join(paths.dataDir, 'agent-runtime');
}

function agentDirectory(agentId: FlowAgentId) {
  return join(agentRuntimeRoot(), 'agents', agentId);
}

function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function materializeAgent(agentId: FlowAgentId, prompt: string, memory: string) {
  const directory = agentDirectory(agentId);
  mkdirSync(join(directory, 'memory'), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'history'), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'candidates'), { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, 'PROMPT.md'), `${prompt.trim()}\n`);
  atomicWrite(join(directory, 'MEMORY.md'), `${memory.trim()}\n`);
}

async function writeManifest() {
  const db = await databaseConnection();
  const profiles = db.prepare(`
    SELECT agent_id, current_prompt_version, current_memory_revision,
           candidate_prompt_version, canary_remaining, prompt_seed_revision, updated_at
    FROM agent_profiles ORDER BY agent_id
  `).all();
  atomicWrite(join(agentRuntimeRoot(), 'manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    workspaceHash: paths.repoHash,
    workspaceRoot: paths.root,
    profiles,
  }, null, 2)}\n`);
}

export async function ensureAgentRuntimeWorkspace() {
  const db = await databaseConnection();
  mkdirSync(join(agentRuntimeRoot(), 'agents'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'observations'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'evaluations'), { recursive: true, mode: 0o700 });

  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO agent_profiles(agent_id, display_name, prompt_seed_revision)
    VALUES(?, ?, ?)
  `);
  const insertPrompt = db.prepare(`
    INSERT OR IGNORE INTO agent_prompt_versions(
      agent_id, version, content, content_hash, status, source, reason
    ) VALUES(?, 1, ?, ?, 'active', 'seed', '初始角色 Prompt')
  `);
  const insertMemory = db.prepare(`
    INSERT OR IGNORE INTO agent_memory_versions(
      agent_id, revision, content, content_hash, source, reason
    ) VALUES(?, 1, ?, ?, 'seed', '初始长期记忆')
  `);
  db.transaction(() => {
    for (const agentId of FLOW_AGENT_IDS) {
      const definition = AGENT_PROFILE_DEFINITIONS[agentId];
      insertProfile.run(agentId, definition.label, AGENT_PROMPT_SEED_REVISION);
      insertPrompt.run(agentId, definition.prompt, hash(definition.prompt));
      insertMemory.run(agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
    }
  })();

  for (const agentId of FLOW_AGENT_IDS) await reconcileAgentFiles(agentId);
  await upgradeSeedPrompts();
  await writeManifest();
  return agentRuntimeRoot();
}

async function upgradeSeedPrompts() {
  const db = await databaseConnection();
  for (const agentId of FLOW_AGENT_IDS) {
    const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
    if (profile.prompt_seed_revision >= AGENT_PROMPT_SEED_REVISION) continue;
    const current = db.prepare(`
      SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?
    `).get(agentId, profile.current_prompt_version) as PromptVersion;
    if (current.source === 'seed' && !profile.candidate_prompt_version) {
      await createPromptVersion(
        agentId,
        AGENT_PROFILE_DEFINITIONS[agentId].prompt,
        'seed',
        `升级内置角色 Prompt seed r${AGENT_PROMPT_SEED_REVISION}`,
        { fromSeedRevision: profile.prompt_seed_revision, toSeedRevision: AGENT_PROMPT_SEED_REVISION },
      );
    }
    db.prepare(`
      UPDATE agent_profiles SET prompt_seed_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?
    `).run(AGENT_PROMPT_SEED_REVISION, agentId);
  }
}

async function reconcileAgentFiles(agentId: FlowAgentId) {
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
  const selectedVersion = profile.candidate_prompt_version || profile.current_prompt_version;
  let prompt = db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?').get(agentId, selectedVersion) as PromptVersion;
  let memory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as MemoryVersion;
  const directory = agentDirectory(agentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const promptPath = join(directory, 'PROMPT.md');
  const memoryPath = join(directory, 'MEMORY.md');

  try {
    const local = promptSchema.parse(readFileSync(promptPath, 'utf8'));
    if (hash(local) !== prompt.content_hash) {
      await createPromptVersion(agentId, local, 'local', '检测到本地 PROMPT.md 修改');
      const next = await getAgentProfile(agentId, false);
      prompt = next.currentPrompt;
    }
  } catch { /* Missing or invalid local files are rematerialized from SQLite. */ }
  try {
    const local = memorySchema.parse(readFileSync(memoryPath, 'utf8'));
    if (hash(local) !== memory.content_hash) {
      await createMemoryVersion(agentId, local, 'local', '检测到本地 MEMORY.md 修改');
      const next = await getAgentProfile(agentId, false);
      memory = next.currentMemory;
    }
  } catch { /* Missing or invalid local files are rematerialized from SQLite. */ }
  materializeAgent(agentId, prompt.content, memory.content);
}

export async function listAgentProfiles() {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  return db.prepare(`
    SELECT profile.*,
      (SELECT COUNT(*) FROM agent_observations observation WHERE observation.agent_id = profile.agent_id) AS observation_count,
      (SELECT COUNT(*) FROM agent_observations observation WHERE observation.agent_id = profile.agent_id AND observation.status IN ('promoted_memory', 'promoted_prompt')) AS promoted_count,
      (SELECT COUNT(*) FROM execution_attempts attempt WHERE attempt.agent = profile.agent_id) AS execution_count
    FROM agent_profiles profile
    ORDER BY CASE profile.agent_id
      WHEN 'backlog-agent' THEN 1 WHEN 'story-splitter-agent' THEN 2
      WHEN 'analyst-agent' THEN 3 WHEN 'repro-agent' THEN 4
      WHEN 'dev-agent' THEN 5 WHEN 'test-agent' THEN 6
      WHEN 'review-agent' THEN 7 ELSE 8 END
  `).all() as (AgentProfile & { observation_count: number; promoted_count: number; execution_count: number })[];
}

export async function getAgentProfile(agentIdInput: string, ensure = true) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const agentId = agentIdInput;
  if (ensure) await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile | undefined;
  if (!profile) throw new Error(`Agent Profile 不存在：${agentId}`);
  const currentPrompt = db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?').get(agentId, profile.current_prompt_version) as PromptVersion;
  const candidatePrompt = profile.candidate_prompt_version
    ? db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?').get(agentId, profile.candidate_prompt_version) as PromptVersion
    : null;
  const currentMemory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as MemoryVersion;
  const promptHistory = db.prepare('SELECT * FROM agent_prompt_versions WHERE agent_id = ? ORDER BY version DESC').all(agentId) as PromptVersion[];
  const memoryHistory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? ORDER BY revision DESC').all(agentId) as MemoryVersion[];
  const observations = db.prepare(`
    SELECT * FROM agent_observations WHERE agent_id = ?
    ORDER BY last_seen_at DESC, observation_id DESC LIMIT 100
  `).all(agentId) as AgentObservation[];
  const dailyFiles = readdirSync(join(agentDirectory(agentId), 'memory')).filter((name) => name.endsWith('.md')).sort().reverse();
  const dailyMemories = dailyFiles.slice(0, 14).map((name) => ({
    name,
    content: readFileSync(join(agentDirectory(agentId), 'memory', name), 'utf8'),
  }));
  return {
    definition: AGENT_PROFILE_DEFINITIONS[agentId],
    profile,
    currentPrompt,
    candidatePrompt,
    currentMemory,
    promptHistory,
    memoryHistory,
    observations,
    dailyFiles,
    dailyMemories,
    runtimeDirectory: agentDirectory(agentId),
  };
}

async function createPromptVersion(agentId: FlowAgentId, contentInput: string, source: PromptVersion['source'], reason: string, evidence?: unknown) {
  const content = promptSchema.parse(contentInput);
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
  const version = ((db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM agent_prompt_versions WHERE agent_id = ?').get(agentId) as { version: number }).version || 0) + 1;
  db.transaction(() => {
    db.prepare("UPDATE agent_prompt_versions SET status = 'superseded' WHERE agent_id = ? AND status IN ('active', 'candidate')").run(agentId);
    db.prepare(`
      INSERT INTO agent_prompt_versions(agent_id, version, content, content_hash, status, source, reason, evidence_json)
      VALUES(?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(agentId, version, content, hash(content), source, reason, evidence ? JSON.stringify(evidence) : null);
    db.prepare(`
      UPDATE agent_profiles
      SET current_prompt_version = ?, candidate_prompt_version = NULL, canary_remaining = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(version, agentId);
  })();
  materializeAgent(agentId, content, (db.prepare('SELECT content FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as { content: string }).content);
  await writeManifest();
  return version;
}

async function createMemoryVersion(agentId: FlowAgentId, contentInput: string, source: MemoryVersion['source'], reason: string, evidence?: unknown) {
  const content = memorySchema.parse(contentInput) || '# Durable Memory';
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
  const revision = ((db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_memory_versions WHERE agent_id = ?').get(agentId) as { revision: number }).revision || 0) + 1;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_memory_versions(agent_id, revision, content, content_hash, source, reason, evidence_json)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(agentId, revision, content, hash(content), source, reason, evidence ? JSON.stringify(evidence) : null);
    db.prepare('UPDATE agent_profiles SET current_memory_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?').run(revision, agentId);
  })();
  const promptVersion = profile.candidate_prompt_version || profile.current_prompt_version;
  const prompt = db.prepare('SELECT content FROM agent_prompt_versions WHERE agent_id = ? AND version = ?').get(agentId, promptVersion) as { content: string };
  materializeAgent(agentId, prompt.content, content);
  await writeManifest();
  return revision;
}

export async function saveAgentPrompt(input: { agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const version = await createPromptVersion(input.agentId, String(input.content ?? ''), 'human', String(input.reason || '用户编辑 Prompt'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return version;
}

export async function saveAgentMemory(input: { agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const revision = await createMemoryVersion(input.agentId, String(input.content ?? ''), 'human', String(input.reason || '用户编辑长期记忆'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function setAgentAutoEvolution(input: { agentId: string; enabled: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  const db = await databaseConnection();
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  db.prepare('UPDATE agent_profiles SET auto_evolve = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?').run(enabled ? 1 : 0, input.agentId);
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
}

export async function rollbackAgentPrompt(input: { agentId: string; version: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const version = z.coerce.number().int().positive().parse(input.version);
  const db = await databaseConnection();
  const row = db.prepare('SELECT content FROM agent_prompt_versions WHERE agent_id = ? AND version = ?').get(input.agentId, version) as { content: string } | undefined;
  if (!row) throw new Error('Prompt 历史版本不存在');
  return createPromptVersion(input.agentId, row.content, 'human', `从 v${version} 回滚`);
}

function recentMemory(agentId: FlowAgentId) {
  const directory = join(agentDirectory(agentId), 'memory');
  const names = readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().slice(-2);
  let content = names.map((name) => `## ${name}\n${readFileSync(join(directory, name), 'utf8').trim()}`).join('\n\n');
  if (content.length > 6_000) content = content.slice(-6_000);
  return content;
}

export async function loadAgentRuntime(agentIdInput: string, pipeline?: string): Promise<AgentRuntimeContext> {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  await ensureAgentRuntimeWorkspace();
  const detail = await getAgentProfile(agentIdInput, false);
  const selected = detail.candidatePrompt || detail.currentPrompt;
  const modeInstruction = pipeline === 'resume'
    ? agentIdInput === 'analyst-agent'
      ? '根据上下文中的用户答复更新当前交付单元的方案分析。'
      : '读取上下文中已回答的运行信息，从暂停点继续当前阶段；重新核验条件，不重复已经完成且仍然有效的工作。'
    : '只处理当前委派阶段和交付单元，不扩张到无关工作。';
  return {
    agentId: agentIdInput,
    prompt: selected.content.replaceAll('{{mode_instruction}}', modeInstruction),
    promptVersion: selected.version,
    promptHash: selected.content_hash,
    promptStatus: selected.status === 'candidate' ? 'candidate' : 'active',
    evolutionCandidateId: selected.status === 'candidate' ? `${agentIdInput}:prompt:v${selected.version}` : null,
    memory: detail.currentMemory.content,
    memoryRevision: detail.currentMemory.revision,
    memoryHash: detail.currentMemory.content_hash,
    recentMemory: recentMemory(agentIdInput),
  };
}

export const agentProfileInternals = { createPromptVersion, createMemoryVersion, agentDirectory, atomicWrite, writeManifest };
