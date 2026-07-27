import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  current_prompt_overlay_revision: number;
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
  content: string;
  content_hash: string;
  reason: string | null;
  updated_at: string;
  status: 'active';
};

export type PromptOverlay = {
  agent_id: FlowAgentId;
  revision: number;
  content: string;
  content_hash: string;
  source: 'human' | 'evolution';
  reason: string | null;
  evidence_json: string | null;
  updated_at: string;
  status: 'active';
};

export type PromptCandidate = {
  candidate_id: string;
  agent_id: FlowAgentId;
  revision: number;
  base_overlay_revision: number;
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

type PromptOverlaySource = PromptOverlay['source'];

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
  promptOverlayRevision: number;
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

const promptOverlaySchema = z.string().trim().max(20_000);
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
type PromptOverlayRow = Omit<PromptOverlay, 'status'>;
type PromptCandidateRow = Omit<PromptCandidate, 'status'>;

function currentPromptInDb(db: AgentDatabase, agentId: FlowAgentId): CurrentPrompt {
  const row = db.prepare('SELECT * FROM agent_prompts WHERE agent_id = ?').get(agentId) as CurrentPromptRow | undefined;
  if (!row) throw new Error(`Agent 当前 Prompt 不存在：${agentId}`);
  return { ...row, status: 'active' };
}

function promptOverlayInDb(db: AgentDatabase, agentId: FlowAgentId): PromptOverlay | null {
  const row = db.prepare('SELECT * FROM agent_prompt_overlays WHERE agent_id = ?').get(agentId) as PromptOverlayRow | undefined;
  return row ? { ...row, status: 'active' } : null;
}

function promptCandidateInDb(db: AgentDatabase, agentId: FlowAgentId): PromptCandidate | null {
  const row = db.prepare('SELECT * FROM agent_prompt_candidates WHERE agent_id = ?').get(agentId) as PromptCandidateRow | undefined;
  return row ? { ...row, status: 'candidate' } : null;
}

export function composeRolePrompt(base: CurrentPrompt, overlay?: Pick<PromptOverlay | PromptCandidate, 'content'> | null) {
  const overlayContent = overlay?.content.trim();
  if (!overlayContent) return base.content.trim();
  return `${base.content.trim()}\n\n# Project Prompt Overlay\n\n${overlayContent}`;
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

function reconcilePromptCandidateInDb(db: AgentDatabase, agentId: FlowAgentId) {
  return db.transaction(() => {
    const candidate = promptCandidateInDb(db, agentId);
    if (!candidate) return false;
    const attempts = db.prepare(`
      SELECT execution_id, status, result_json
      FROM execution_attempts
      WHERE evolution_candidate_id = ?
      ORDER BY created_at, execution_id
    `).all(candidate.candidate_id) as CanaryAttemptRow[];
    const outcomes = attempts.map((attempt) => ({
      ...attempt,
      outcome: canaryAttemptOutcome(attempt),
    }));
    let fingerprint = '';
    try {
      fingerprint = String(JSON.parse(candidate.evidence_json || '{}').fingerprint || '');
    } catch { /* Invalid evidence can still be safely discarded or promoted. */ }

    const discard = () => {
      db.prepare('DELETE FROM agent_prompt_candidates WHERE candidate_id = ? AND agent_id = ?').run(candidate.candidate_id, agentId);
      db.prepare(`
        UPDATE agent_profiles
        SET candidate_prompt_version = NULL, canary_remaining = 0, updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(agentId);
      if (fingerprint) {
        db.prepare(`
          UPDATE agent_observations SET status = 'rejected', last_seen_at = CURRENT_TIMESTAMP
          WHERE agent_id = ? AND fingerprint = ? AND status = 'prompt_candidate'
        `).run(agentId, fingerprint);
      }
    };

    if (outcomes.some((attempt) => attempt.outcome === 'failed')) {
      discard();
      return true;
    }

    const activeCount = outcomes.filter((attempt) => attempt.outcome === 'active').length;
    const successes = outcomes.filter((attempt) => attempt.outcome === 'succeeded');
    const remaining = Math.max(0, 3 - successes.length);
    if (activeCount === 0 && remaining === 0) {
      const finalExecutionId = successes.at(-1)?.execution_id || 'unknown';
      const promotionReason = [candidate.reason, `Canary 通过，最终 execution ${finalExecutionId}`].filter(Boolean).join('；');
      const currentOverlay = promptOverlayInDb(db, agentId);
      if ((currentOverlay?.revision || 0) !== candidate.base_overlay_revision) {
        discard();
        return true;
      }
      db.prepare(`
        INSERT INTO agent_prompt_overlays(
          agent_id, revision, content, content_hash, source, reason, evidence_json
        ) VALUES(?, ?, ?, ?, 'evolution', ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          revision = excluded.revision,
          content = excluded.content,
          content_hash = excluded.content_hash,
          source = excluded.source,
          reason = excluded.reason,
          evidence_json = excluded.evidence_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        agentId,
        candidate.revision,
        candidate.content,
        candidate.content_hash,
        promotionReason,
        candidate.evidence_json,
      );
      db.prepare('DELETE FROM agent_prompt_candidates WHERE candidate_id = ? AND agent_id = ?').run(candidate.candidate_id, agentId);
      if (fingerprint) {
        db.prepare(`
          UPDATE agent_observations SET status = 'promoted_prompt', last_seen_at = CURRENT_TIMESTAMP
          WHERE agent_id = ? AND fingerprint = ?
        `).run(agentId, fingerprint);
      }
      db.prepare(`
        UPDATE agent_profiles
        SET current_prompt_overlay_revision = ?, candidate_prompt_version = NULL, canary_remaining = 0,
            last_evolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(candidate.revision, agentId);
      return true;
    }

    db.prepare(`
      UPDATE agent_prompt_candidates
      SET remaining_runs = ?, updated_at = CURRENT_TIMESTAMP
      WHERE candidate_id = ? AND agent_id = ?
    `).run(remaining, candidate.candidate_id, agentId);
    db.prepare(`
      UPDATE agent_profiles
      SET candidate_prompt_version = ?, canary_remaining = ?, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(candidate.revision, remaining, agentId);
    return remaining !== candidate.remaining_runs;
  }).immediate();
}

async function writeManifest() {
  const db = await databaseConnection();
  const profiles = db.prepare(`
    SELECT agent_id, current_prompt_version, current_prompt_overlay_revision, current_memory_revision,
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
  const upsertBasePrompt = db.prepare(`
    INSERT INTO agent_prompts(
      agent_id, version, content, content_hash, reason
    ) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      version = excluded.version,
      content = excluded.content,
      content_hash = excluded.content_hash,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
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
      upsertBasePrompt.run(
        agentId,
        AGENT_PROMPT_SEED_REVISION,
        definition.prompt,
        hash(definition.prompt),
        `V${AGENT_PROMPT_SEED_REVISION} 内置角色 Prompt`,
      );
      db.prepare(`
        UPDATE agent_profiles
        SET display_name = ?, current_prompt_version = ?, prompt_seed_revision = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(definition.label, AGENT_PROMPT_SEED_REVISION, AGENT_PROMPT_SEED_REVISION, agentId);
      insertMemory.run(agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
    }
  }).immediate();

  for (const agentId of FLOW_AGENT_IDS) {
    reconcilePromptCandidateInDb(db, agentId);
    await reconcileAgentFiles(agentId);
  }
  await writeManifest();
  return agentRuntimeRoot();
}

async function reconcileAgentFiles(agentId: FlowAgentId) {
  const db = await databaseConnection();
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
  const basePrompt = currentPromptInDb(db, agentId);
  const overlay = promptCandidateInDb(db, agentId) || promptOverlayInDb(db, agentId);
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
  materializeAgent(agentId, composeRolePrompt(basePrompt, overlay), memory.content);
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
  const currentPrompt = currentPromptInDb(db, agentId);
  const currentOverlay = promptOverlayInDb(db, agentId);
  const candidatePrompt = promptCandidateInDb(db, agentId);
  const currentMemory = db.prepare('SELECT * FROM agent_memory_versions WHERE agent_id = ? AND revision = ?').get(agentId, profile.current_memory_revision) as MemoryVersion;
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
    currentOverlay,
    candidatePrompt,
    currentMemory,
    memoryHistory,
    observations,
    dailyFiles,
    dailyMemories,
    runtimeDirectory: agentDirectory(agentId),
  };
}

async function replacePromptOverlay(agentId: FlowAgentId, contentInput: string, source: PromptOverlaySource, reason: string, evidence?: unknown) {
  const content = promptOverlaySchema.parse(contentInput);
  const db = await databaseConnection();
  const replaced = db.transaction(() => {
    const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile;
    const currentOverlay = promptOverlayInDb(db, agentId);
    const candidate = promptCandidateInDb(db, agentId);
    const revision = (currentOverlay?.revision || 0) + 1;
    let candidateFingerprint = '';
    try {
      candidateFingerprint = String(JSON.parse(candidate?.evidence_json || '{}').fingerprint || '');
    } catch { /* Invalid candidate evidence does not block a human replacement. */ }
    db.prepare(`
      INSERT INTO agent_prompt_overlays(
        agent_id, revision, content, content_hash, source, reason, evidence_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        revision = excluded.revision,
        content = excluded.content,
        content_hash = excluded.content_hash,
        source = excluded.source,
        reason = excluded.reason,
        evidence_json = excluded.evidence_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(agentId, revision, content, hash(content), source, reason, evidence ? JSON.stringify(evidence) : null);
    db.prepare('DELETE FROM agent_prompt_candidates WHERE agent_id = ?').run(agentId);
    if (candidateFingerprint) {
      db.prepare(`
        UPDATE agent_observations SET status = 'rejected', last_seen_at = CURRENT_TIMESTAMP
        WHERE agent_id = ? AND fingerprint = ? AND status = 'prompt_candidate'
      `).run(agentId, candidateFingerprint);
    }
    db.prepare(`
      UPDATE agent_profiles
      SET current_prompt_overlay_revision = ?, candidate_prompt_version = NULL, canary_remaining = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(revision, agentId);
    return { revision, memoryRevision: profile.current_memory_revision };
  }).immediate();
  const memory = db.prepare(`
    SELECT content FROM agent_memory_versions WHERE agent_id = ? AND revision = ?
  `).get(agentId, replaced.memoryRevision) as { content: string };
  const basePrompt = currentPromptInDb(db, agentId);
  materializeAgent(agentId, composeRolePrompt(basePrompt, { content }), memory.content);
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
  const basePrompt = currentPromptInDb(db, agentId);
  const overlay = promptCandidateInDb(db, agentId) || promptOverlayInDb(db, agentId);
  materializeAgent(agentId, composeRolePrompt(basePrompt, overlay), content);
  await writeManifest();
  return revision;
}

export async function saveAgentPromptOverlay(input: { agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const revision = await replacePromptOverlay(input.agentId, String(input.content ?? ''), 'human', String(input.reason || '用户编辑项目 Prompt Overlay'));
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
  const selectedOverlay = detail.candidatePrompt || detail.currentOverlay;
  const composedPrompt = composeRolePrompt(detail.currentPrompt, selectedOverlay);
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
    promptVersion: detail.currentPrompt.version,
    promptOverlayRevision: selectedOverlay?.revision || 0,
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
  agentDirectory,
  atomicWrite,
  promptOverlayInDb,
  promptCandidateInDb,
};
