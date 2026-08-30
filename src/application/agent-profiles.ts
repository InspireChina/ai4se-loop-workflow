import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, DEFAULT_AGENT_MEMORY, FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import {
  activeAgentConfigurationPrompt,
  activeAgentConfigurationPromptCandidate,
  saveActiveAgentConfigurationPrompt,
  syncAgentConfigurationCanaryReceipts,
} from './agent-configurations';

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

export type CurrentPrompt = {
  agent_id: FlowAgentId;
  version: number;
  template_version: number;
  content: string;
  content_hash: string;
  source: 'system' | 'human' | 'evolution';
  reason: string | null;
  updated_at: string;
  status: 'active';
};

export type PromptCandidate = {
  candidate_id: string;
  agent_id: FlowAgentId;
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
  promptTemplateVersion: number;
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

export type DailyMemoryObservation = {
  executionId: string;
  fingerprint: string;
  summary: string;
  content: string;
  promoted: boolean;
};

const promptSchema = z.string().trim().min(1).max(100_000);
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
  rmSync(join(directory, 'history'), { recursive: true, force: true });
  rmSync(join(directory, 'candidates'), { recursive: true, force: true });
  atomicWrite(join(directory, 'PROMPT.md'), `${prompt.trim()}\n`);
  atomicWrite(join(directory, 'MEMORY.md'), `${memory.trim()}\n`);
}

type AgentDatabase = Awaited<ReturnType<typeof databaseConnection>>;
type CurrentPromptRow = Omit<CurrentPrompt, 'status'>;

function currentPromptInDb(db: AgentDatabase, agentId: FlowAgentId): CurrentPrompt {
  const row = db.prepare('SELECT * FROM agent_prompts WHERE agent_id = ?').get(agentId) as CurrentPromptRow | undefined;
  if (!row) throw new Error(`Agent 当前 Prompt 不存在：${agentId}`);
  return { ...row, status: 'active' };
}

function parseDailyMemoryObservations(content: string, durableMemory = ''): DailyMemoryObservation[] {
  const markers = [...content.matchAll(/<!-- execution:([^\s]+) fingerprint:([^\s]+) -->/gu)];
  return markers.flatMap((marker, index) => {
    const start = (marker.index || 0) + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : content.length;
    const section = content.slice(start, end).trim();
    const summary = section.match(/^##\s+(.+)$/mu)?.[1]?.trim();
    if (!summary) return [];
    const fingerprint = marker[2];
    return [{
      executionId: marker[1],
      fingerprint,
      summary,
      content: section,
      promoted: durableMemory.includes(`<!-- EVOLUTION:${fingerprint} -->`),
    }];
  });
}

type CanaryAttemptRow = {
  execution_id: string;
  status: string;
  result_json: string | null;
};

const ACTIVE_EXECUTION_STATUSES = new Set(['planned', 'running', 'output_received', 'verifying', 'applying']);
const FAILED_EXECUTION_STATUSES = new Set(['retryable_failed', 'system_blocked']);

function canaryAttemptOutcome(attempt: CanaryAttemptRow): 'active' | 'succeeded' | 'failed' | 'ignored' {
  if (ACTIVE_EXECUTION_STATUSES.has(attempt.status)) return 'active';
  if (FAILED_EXECUTION_STATUSES.has(attempt.status)) return 'failed';
  if (attempt.status !== 'applied') return 'ignored';
  try {
    const result = JSON.parse(attempt.result_json || '') as { outcome?: string; verdict?: string };
    return result.outcome === 'failed' || result.verdict === 'failed' ? 'failed' : 'succeeded';
  } catch {
    return 'failed';
  }
}

function reconcileGlobalPromptCandidateInProject(db: AgentDatabase, agentId: FlowAgentId) {
  const candidate = activeAgentConfigurationPromptCandidate(agentId);
  const receipts = candidate
    ? (db.prepare(`
        SELECT execution_id, status, result_json
        FROM execution_attempts
        WHERE evolution_candidate_id = ?
        ORDER BY created_at, execution_id
      `).all(candidate.candidate_id) as CanaryAttemptRow[]).map((attempt) => ({
        executionId: attempt.execution_id,
        outcome: canaryAttemptOutcome(attempt),
      }))
    : [];
  const result = syncAgentConfigurationCanaryReceipts({ agentId, receipts });
  const nextCandidate = activeAgentConfigurationPromptCandidate(agentId);
  const current = activeAgentConfigurationPrompt(agentId);
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_profiles
      SET current_prompt_version = ?, candidate_prompt_version = ?, canary_remaining = ?,
          last_evolved_at = CASE WHEN ? IN ('promoted', 'rejected') THEN CURRENT_TIMESTAMP ELSE last_evolved_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(
      current.revision,
      nextCandidate?.revision || null,
      nextCandidate?.remaining_runs || 0,
      result.status,
      agentId,
    );
    if (result.fingerprint && result.status === 'promoted') {
      db.prepare(`
        UPDATE agent_observations SET status = 'promoted_prompt', last_seen_at = CURRENT_TIMESTAMP
        WHERE agent_id = ? AND fingerprint = ?
      `).run(agentId, result.fingerprint);
    } else if (result.fingerprint && result.status === 'rejected') {
      db.prepare(`
        UPDATE agent_observations SET status = 'rejected', last_seen_at = CURRENT_TIMESTAMP
        WHERE agent_id = ? AND fingerprint = ? AND status = 'prompt_candidate'
      `).run(agentId, result.fingerprint);
    }
  })();
}

async function writeManifest() {
  const db = await databaseConnection();
  const profiles = db.prepare(`
    SELECT agent_id, current_prompt_version, current_memory_revision,
           candidate_prompt_version, canary_remaining, prompt_seed_revision, updated_at
    FROM agent_profiles ORDER BY agent_id
  `).all();
  atomicWrite(join(agentRuntimeRoot(), 'manifest.json'), `${JSON.stringify({
    formatVersion: 2,
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
  const insertProjectPrompt = db.prepare(`
    INSERT INTO agent_prompts(
      agent_id, version, template_version, content, content_hash, source, reason
    ) VALUES(?, 1, ?, ?, ?, 'system', ?)
    ON CONFLICT(agent_id) DO NOTHING
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
      const inserted = insertProjectPrompt.run(
        agentId,
        AGENT_PROMPT_SEED_REVISION,
        definition.prompt,
        hash(definition.prompt),
        `由系统模板 V${AGENT_PROMPT_SEED_REVISION} 初始化`,
      );
      let projectPrompt = currentPromptInDb(db, agentId);
      const existingProfile = db.prepare(`
        SELECT prompt_seed_revision, candidate_prompt_version
        FROM agent_profiles WHERE agent_id = ?
      `).get(agentId) as Pick<AgentProfile, 'prompt_seed_revision' | 'candidate_prompt_version'>;
      const canUpgradeSystemSeed = !inserted.changes
        && projectPrompt.source === 'system'
        && projectPrompt.template_version < AGENT_PROMPT_SEED_REVISION
        && existingProfile.prompt_seed_revision === projectPrompt.template_version
        && existingProfile.candidate_prompt_version === null;
      if (canUpgradeSystemSeed) {
        db.prepare(`
          UPDATE agent_prompts
          SET version = version + 1,
              template_version = ?,
              content = ?,
              content_hash = ?,
              reason = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(
          AGENT_PROMPT_SEED_REVISION,
          definition.prompt,
          hash(definition.prompt),
          `自动升级到系统模板 V${AGENT_PROMPT_SEED_REVISION}`,
          agentId,
        );
        db.prepare(`
          UPDATE agent_profiles
          SET prompt_seed_revision = ?, updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(AGENT_PROMPT_SEED_REVISION, agentId);
        projectPrompt = currentPromptInDb(db, agentId);
      }
      if (projectPrompt.content_hash !== hash(projectPrompt.content)) {
        db.prepare(`
          UPDATE agent_prompts
          SET content_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(hash(projectPrompt.content), agentId);
      }
      db.prepare(`
        UPDATE agent_profiles
        SET display_name = ?, current_prompt_version = ?,
            prompt_seed_revision = CASE WHEN ? = 1 THEN ? ELSE prompt_seed_revision END,
            updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(
        definition.label,
        projectPrompt.version,
        inserted.changes,
        AGENT_PROMPT_SEED_REVISION,
        agentId,
      );
      insertMemory.run(agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
    }
  }).immediate();

  for (const agentId of FLOW_AGENT_IDS) {
    reconcileGlobalPromptCandidateInProject(db, agentId);
    await reconcileAgentFiles(agentId);
  }
  await writeManifest();
  return agentRuntimeRoot();
}

async function reconcileAgentFiles(agentId: FlowAgentId) {
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
  const globalPrompt = activeAgentConfigurationPrompt(agentId);
  let memory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as MemoryVersion;
  const directory = agentDirectory(agentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const memoryPath = join(directory, 'MEMORY.md');

  try {
    const local = memorySchema.parse(readFileSync(memoryPath, 'utf8'));
    if (hash(local) !== memory.content_hash) {
      await createMemoryVersion(agentId, local, 'local', '检测到本地 MEMORY.md 修改');
      const next = await getAgentProfile(agentId, false);
      memory = next.currentMemory;
    }
  } catch { /* Missing or invalid local files are rematerialized from SQLite. */ }
  materializeAgent(agentId, globalPrompt.content, memory.content);
}

export async function listAgentProfiles() {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const profiles = db.prepare(`
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
  return profiles.map((profile) => ({
    ...profile,
    current_prompt_version: activeAgentConfigurationPrompt(profile.agent_id).revision,
    candidate_prompt_version: activeAgentConfigurationPromptCandidate(profile.agent_id)?.revision || null,
    canary_remaining: activeAgentConfigurationPromptCandidate(profile.agent_id)?.remaining_runs || 0,
  }));
}

export async function getAgentProfile(agentIdInput: string, ensure = true) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const agentId = agentIdInput;
  if (ensure) await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const storedProfile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile | undefined;
  const globalPrompt = activeAgentConfigurationPrompt(agentId);
  const globalCandidate = activeAgentConfigurationPromptCandidate(agentId);
  const profile = storedProfile ? {
    ...storedProfile,
    current_prompt_version: globalPrompt.revision,
    candidate_prompt_version: globalCandidate?.revision || null,
    canary_remaining: globalCandidate?.remaining_runs || 0,
  } : undefined;
  if (!profile) throw new Error(`Agent Profile 不存在：${agentId}`);
  const currentPrompt: CurrentPrompt = {
    agent_id: agentId,
    version: globalPrompt.revision,
    template_version: globalPrompt.templateVersion,
    content: globalPrompt.content,
    content_hash: globalPrompt.contentHash,
    source: globalPrompt.source,
    reason: globalPrompt.reason,
    updated_at: globalPrompt.updatedAt,
    status: 'active',
  };
  const candidatePrompt: PromptCandidate | null = globalCandidate ? {
    candidate_id: globalCandidate.candidate_id,
    agent_id: globalCandidate.agent_id,
    revision: globalCandidate.revision,
    base_prompt_revision: globalCandidate.base_prompt_revision,
    content: globalCandidate.content,
    content_hash: globalCandidate.content_hash,
    source: 'evolution',
    reason: globalCandidate.reason,
    evidence_json: globalCandidate.evidence_json,
    remaining_runs: globalCandidate.remaining_runs,
    created_at: globalCandidate.created_at,
    updated_at: globalCandidate.updated_at,
    status: 'candidate',
  } : null;
  const currentMemory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as MemoryVersion;
  const memoryHistory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? ORDER BY revision DESC').all(agentId) as MemoryVersion[];
  const observations = db.prepare(`
    SELECT * FROM agent_observations WHERE agent_id = ?
    ORDER BY last_seen_at DESC, observation_id DESC LIMIT 100
  `).all(agentId) as AgentObservation[];
  const dailyFiles = readdirSync(join(agentDirectory(agentId), 'memory')).filter((name) => name.endsWith('.md')).sort().reverse();
  const dailyMemories = dailyFiles.slice(0, 14).map((name) => {
    const content = readFileSync(join(agentDirectory(agentId), 'memory', name), 'utf8');
    return {
      name,
      content,
      observations: parseDailyMemoryObservations(content, currentMemory.content),
    };
  });
  return {
    definition: AGENT_PROFILE_DEFINITIONS[agentId],
    profile,
    currentPrompt,
    candidatePrompt: candidatePrompt as PromptCandidate | null,
    currentMemory,
    memoryHistory,
    observations,
    dailyFiles,
    dailyMemories,
    runtimeDirectory: agentDirectory(agentId),
  };
}

async function replaceProjectPrompt(
  agentId: FlowAgentId,
  contentInput: string,
  reason: string,
  source: CurrentPrompt['source'] = 'human',
  templateVersionInput?: number,
  skipIfUnchanged = false,
) {
  const content = promptSchema.parse(contentInput);
  const db = await databaseConnection();
  const current = activeAgentConfigurationPrompt(agentId);
  if (skipIfUnchanged && current.contentHash === hash(content)) return current.revision;
  const configuration = saveActiveAgentConfigurationPrompt({
    agentId,
    content,
    source,
    reason,
    templateVersion: templateVersionInput || AGENT_PROMPT_SEED_REVISION,
  });
  const replaced = { revision: configuration.promptRevision, memoryRevision: (db.prepare(`
    SELECT current_memory_revision FROM agent_profiles WHERE agent_id = ?
  `).get(agentId) as { current_memory_revision: number }).current_memory_revision };
  db.prepare(`
    UPDATE agent_profiles
    SET current_prompt_version = ?, candidate_prompt_version = NULL, canary_remaining = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `).run(replaced.revision, agentId);
  const memory = db.prepare(`
    SELECT content FROM agent_memory_versions WHERE agent_id = ? AND revision = ?
  `).get(agentId, replaced.memoryRevision) as { content: string };
  materializeAgent(agentId, content, memory.content);
  await writeManifest();
  return replaced.revision;
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
  materializeAgent(agentId, activeAgentConfigurationPrompt(agentId).content, content);
  await writeManifest();
  return revision;
}

export async function saveAgentPrompt(input: { agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const revision = await replaceProjectPrompt(input.agentId, String(input.content ?? ''), String(input.reason || '用户编辑全局 Agent Prompt'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function resetAgentPromptToSystemTemplate(input: { agentId: string }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const revision = await replaceProjectPrompt(
    input.agentId,
    AGENT_PROFILE_DEFINITIONS[input.agentId].prompt,
    `用户重置为系统模板 V${AGENT_PROMPT_SEED_REVISION}`,
    'system',
    AGENT_PROMPT_SEED_REVISION,
    true,
  );
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function saveAgentMemory(input: { agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const revision = await createMemoryVersion(input.agentId, String(input.content ?? ''), 'human', String(input.reason || '用户编辑长期记忆'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function promoteDailyMemoryObservation(input: {
  agentId: string;
  memoryName: unknown;
  executionId: unknown;
  fingerprint: unknown;
}) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  const memoryName = z.string().regex(/^\d{4}-\d{2}-\d{2}\.md$/u, 'Daily Memory 文件名无效').parse(input.memoryName);
  const executionId = z.string().trim().min(1).max(200).parse(input.executionId);
  const fingerprint = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,119}$/u, '观察 fingerprint 无效').parse(input.fingerprint);
  await ensureAgentRuntimeWorkspace();
  const detail = await getAgentProfile(input.agentId, false);
  const marker = `<!-- EVOLUTION:${fingerprint} -->`;
  if (detail.currentMemory.content.includes(marker)) return detail.currentMemory.revision;

  const path = join(agentDirectory(input.agentId), 'memory', memoryName);
  let dailyContent = '';
  try { dailyContent = readFileSync(path, 'utf8'); }
  catch { throw new Error(`Daily Memory 不存在：${memoryName}`); }
  const observation = parseDailyMemoryObservations(dailyContent).find((item) => (
    item.executionId === executionId && item.fingerprint === fingerprint
  ));
  if (!observation) throw new Error('Daily Memory 中不存在该观察');
  const guidance = observation.content.match(/^- Guidance:\s*(.+)$/mu)?.[1]?.trim();
  const category = observation.content.match(/^- Category:\s*(.+)$/mu)?.[1]?.trim();
  if (!guidance || !category) throw new Error('Daily Memory 观察缺少 Guidance 或 Category');

  const content = [
    detail.currentMemory.content.trimEnd(),
    '',
    marker,
    `## ${observation.summary}`,
    '',
    guidance,
    '',
    `适用范围：${category}。由用户从 Daily Memory 提升；证据：execution ${executionId}。`,
    '',
  ].join('\n');
  const revision = await createMemoryVersion(
    input.agentId,
    content,
    'human',
    `用户从 ${memoryName} 提升经验 ${fingerprint}`,
    { memoryName, executionId, fingerprint },
  );
  const db = await databaseConnection();
  db.prepare(`
    UPDATE agent_observations SET status = 'promoted_memory', last_seen_at = CURRENT_TIMESTAMP
    WHERE agent_id = ? AND fingerprint = ?
  `).run(input.agentId, fingerprint);
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
  const selectedPrompt = detail.candidatePrompt || detail.currentPrompt;
  const composedPrompt = selectedPrompt.content;
  const modeInstruction = pipeline === 'resume'
    ? agentIdInput === 'backlog-agent'
      ? '根据上下文中已回答的需求级产品问题更新需求目标、范围、路由和交付边界；不要重复询问已经回答的问题。'
      : agentIdInput === 'analyst-agent'
        ? '根据上下文中的用户答复继续当前交付分析；在原 decision key 上消费答案并以 user 权限关闭决策，把关联影响更新为最终处理方式，再收敛冻结交付契约。只保留仍然超出角色权限、会造成实质不同交付后果的最少问题。已回答问题的 decision key 是跨轮次不可变的系统标识，必须逐字复用，禁止改名或创建别名。'
        : '读取上下文中已回答的运行信息，从暂停点继续当前阶段；重新核验条件，不重复已经完成且仍然有效的工作。'
    : '只处理当前委派阶段和交付单元，不扩张到无关工作。';
  const prompt = composedPrompt.includes('{{mode_instruction}}')
    ? composedPrompt.replaceAll('{{mode_instruction}}', modeInstruction)
    : pipeline === 'resume'
      ? `# 当前恢复要求\n${modeInstruction}\n\n${composedPrompt}`
      : composedPrompt;
  return {
    agentId: agentIdInput,
    prompt,
    promptVersion: detail.candidatePrompt?.revision || detail.currentPrompt.version,
    promptTemplateVersion: detail.currentPrompt.template_version,
    promptHash: hash(prompt),
    promptStatus: detail.candidatePrompt ? 'candidate' : 'active',
    evolutionCandidateId: detail.candidatePrompt?.candidate_id || null,
    memory: detail.currentMemory.content,
    memoryRevision: detail.currentMemory.revision,
    memoryHash: detail.currentMemory.content_hash,
    recentMemory: recentMemory(agentIdInput),
  };
}

export const agentProfileInternals = {
  createMemoryVersion,
  parseDailyMemoryObservations,
  agentDirectory,
  atomicWrite,
};
