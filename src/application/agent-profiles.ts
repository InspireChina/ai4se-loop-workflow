import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, DEFAULT_AGENT_MEMORY, FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import { defaultProjectInDb, projectInDb } from './projects';

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
  project_id: string;
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

export type MemoryVersion = {
  agent_id: FlowAgentId;
  project_id: string;
  revision: number;
  content: string;
  content_hash: string;
  source: 'seed' | 'human' | 'local' | 'evolution' | 'migration';
  reason: string | null;
  evidence_json: string | null;
  created_at: string;
};

export type AgentRuntimeContext = {
  agentId: FlowAgentId;
  projectId: string;
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
  project_id: string;
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

export type ProjectAgentOverlay = {
  project_id: string;
  agent_id: FlowAgentId;
  revision: number;
  content: string;
  content_hash: string;
  source: 'seed' | 'migration' | 'human' | 'evolution';
  reason: string | null;
  updated_at: string;
};

export type DailyMemoryObservation = {
  executionId: string;
  fingerprint: string;
  summary: string;
  content: string;
  promoted: boolean;
};

const overlaySchema = z.string().trim().min(1, '项目 Prompt 不能为空').max(100_000);
const memorySchema = z.string().trim().max(40_000);

export function agentRuntimeRoot() {
  return join(paths.dataDir, 'agent-runtime');
}

function agentDirectory(projectId: string, agentId: FlowAgentId) {
  return join(agentRuntimeRoot(), 'projects', projectId, 'agents', agentId);
}

function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function materializeAgent(projectId: string, agentId: FlowAgentId, prompt: string, memory: string) {
  const directory = agentDirectory(projectId, agentId);
  mkdirSync(join(directory, 'memory'), { recursive: true, mode: 0o700 });
  rmSync(join(directory, 'history'), { recursive: true, force: true });
  rmSync(join(directory, 'candidates'), { recursive: true, force: true });
  atomicWrite(join(directory, 'PROMPT.md'), `${prompt.trim()}\n`);
  atomicWrite(join(directory, 'MEMORY.md'), `${memory.trim()}\n`);
}

type AgentDatabase = Awaited<ReturnType<typeof databaseConnection>>;
function rolePrompt(agentId: FlowAgentId): CurrentPrompt {
  const definition = AGENT_PROFILE_DEFINITIONS[agentId];
  return {
    agent_id: agentId,
    version: AGENT_PROMPT_SEED_REVISION,
    template_version: AGENT_PROMPT_SEED_REVISION,
    content: definition.prompt,
    content_hash: hash(definition.prompt),
    source: 'system',
    reason: `隐藏的全局角色模板 V${AGENT_PROMPT_SEED_REVISION}`,
    updated_at: '',
    status: 'active',
  };
}

function composePrompt(agentId: FlowAgentId, overlay: string) {
  const base = AGENT_PROFILE_DEFINITIONS[agentId].prompt.trim();
  return overlay.trim() || base;
}

function resolveProject(db: AgentDatabase, projectIdInput?: string) {
  const project = projectIdInput ? projectInDb(db, projectIdInput) : defaultProjectInDb(db);
  if (!project) throw new Error('项目不存在');
  return project;
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

function projectOverlayCandidateInDb(db: AgentDatabase, projectId: string, agentId: FlowAgentId) {
  const row = db.prepare(`
    SELECT * FROM project_agent_overlay_candidates
    WHERE project_id = ? AND agent_id = ?
  `).get(projectId, agentId) as Omit<PromptCandidate, 'source' | 'status'> | undefined;
  return row ? { ...row, source: 'evolution' as const, status: 'candidate' as const } : null;
}

export function isActiveProjectOverlayCandidateInDb(
  db: AgentDatabase,
  projectId: string,
  agentId: string,
  candidateId: string,
) {
  return isFlowAgentId(agentId)
    && projectOverlayCandidateInDb(db, projectId, agentId)?.candidate_id === candidateId;
}

function reconcileProjectOverlayCandidate(db: AgentDatabase, projectId: string, agentId: FlowAgentId) {
  const candidate = projectOverlayCandidateInDb(db, projectId, agentId);
  if (!candidate) return;
  const attempts = db.prepare(`
    SELECT execution_id, status, result_json
    FROM execution_attempts
    WHERE evolution_candidate_id = ?
    ORDER BY created_at, execution_id
  `).all(candidate.candidate_id) as CanaryAttemptRow[];
  const outcomes = attempts.map(canaryAttemptOutcome);
  let fingerprint = '';
  try { fingerprint = String(JSON.parse(candidate.evidence_json || '{}').fingerprint || ''); } catch { /* optional evidence */ }
  if (outcomes.includes('failed')) {
    db.prepare('DELETE FROM project_agent_overlay_candidates WHERE candidate_id = ?').run(candidate.candidate_id);
    if (fingerprint) db.prepare(`
      UPDATE project_agent_observations SET status = 'rejected', last_seen_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND agent_id = ? AND fingerprint = ? AND status = 'prompt_candidate'
    `).run(projectId, agentId, fingerprint);
    return;
  }
  const successes = outcomes.filter((outcome) => outcome === 'succeeded').length;
  const active = outcomes.filter((outcome) => outcome === 'active').length;
  const remaining = Math.max(0, 3 - successes);
  if (remaining === 0 && active === 0) {
    db.prepare(`
      UPDATE project_agent_overlays
      SET content = ?, content_hash = ?, revision = ?, source = 'evolution', reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND agent_id = ? AND revision = ?
    `).run(candidate.content, candidate.content_hash, candidate.revision, candidate.reason, projectId, agentId, candidate.base_overlay_revision);
    db.prepare('DELETE FROM project_agent_overlay_candidates WHERE candidate_id = ?').run(candidate.candidate_id);
    if (fingerprint) db.prepare(`
      UPDATE project_agent_observations SET status = 'promoted_prompt', last_seen_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND agent_id = ? AND fingerprint = ?
    `).run(projectId, agentId, fingerprint);
    return;
  }
  db.prepare(`
    UPDATE project_agent_overlay_candidates
    SET remaining_runs = ?, updated_at = CURRENT_TIMESTAMP
    WHERE candidate_id = ?
  `).run(remaining, candidate.candidate_id);
}

async function writeManifest() {
  const db = await databaseConnection();
  const profiles = db.prepare(`
    SELECT state.project_id, state.agent_id, overlay.revision AS overlay_revision,
           state.current_memory_revision, state.auto_evolve, state.updated_at
    FROM project_agent_states state
    JOIN project_agent_overlays overlay
      ON overlay.project_id = state.project_id AND overlay.agent_id = state.agent_id
    ORDER BY state.project_id, state.agent_id
  `).all();
  atomicWrite(join(agentRuntimeRoot(), 'manifest.json'), `${JSON.stringify({
    formatVersion: 4,
    storageScope: 'global',
    profiles,
  }, null, 2)}\n`);
}

export async function ensureAgentRuntimeWorkspace() {
  const db = await databaseConnection();
  mkdirSync(join(agentRuntimeRoot(), 'projects'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'observations'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'evaluations'), { recursive: true, mode: 0o700 });

  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO agent_profiles(agent_id, display_name, prompt_seed_revision)
    VALUES(?, ?, ?)
  `);
  const insertLegacyPrompt = db.prepare(`
    INSERT INTO agent_prompts(
      agent_id, version, template_version, content, content_hash, source, reason
    ) VALUES(?, 1, ?, ?, ?, 'system', ?)
    ON CONFLICT(agent_id) DO NOTHING
  `);
  const insertLegacyMemory = db.prepare(`
    INSERT OR IGNORE INTO agent_memory_versions(
      agent_id, revision, content, content_hash, source, reason
    ) VALUES(?, 1, ?, ?, 'seed', '初始长期记忆')
  `);
  db.transaction(() => {
    for (const agentId of FLOW_AGENT_IDS) {
      const definition = AGENT_PROFILE_DEFINITIONS[agentId];
      insertProfile.run(agentId, definition.label, AGENT_PROMPT_SEED_REVISION);
      insertLegacyPrompt.run(
        agentId,
        AGENT_PROMPT_SEED_REVISION,
        definition.prompt,
        hash(definition.prompt),
        `由系统模板 V${AGENT_PROMPT_SEED_REVISION} 初始化`,
      );
      db.prepare(`
        UPDATE agent_profiles
        SET display_name = ?, current_prompt_version = ?, prompt_seed_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(definition.label, AGENT_PROMPT_SEED_REVISION, AGENT_PROMPT_SEED_REVISION, agentId);
      insertLegacyMemory.run(agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
    }
  }).immediate();

  const projects = db.prepare(`
    SELECT project_id, is_default FROM projects
    WHERE deleted_at IS NULL
    ORDER BY is_default DESC, created_at, project_id
  `)
    .all() as { project_id: string; is_default: number }[];
  db.transaction(() => {
    for (const project of projects) {
      for (const agentId of FLOW_AGENT_IDS) {
        const definition = AGENT_PROFILE_DEFINITIONS[agentId];
        const profile = db.prepare('SELECT current_memory_revision, auto_evolve FROM agent_profiles WHERE agent_id = ?')
          .get(agentId) as Pick<AgentProfile, 'current_memory_revision' | 'auto_evolve'>;
        db.prepare(`
          INSERT OR IGNORE INTO project_agent_states(project_id, agent_id, current_memory_revision, auto_evolve)
          VALUES(?, ?, ?, ?)
        `).run(project.project_id, agentId, project.is_default ? profile.current_memory_revision : 1, profile.auto_evolve);
        db.prepare(`
          INSERT OR IGNORE INTO project_agent_overlays(project_id, agent_id, revision, content, content_hash, source, reason)
          VALUES(?, ?, 1, ?, ?, 'seed', '基于全局角色模板初始化项目 Prompt')
        `).run(project.project_id, agentId, definition.prompt.trim(), hash(definition.prompt.trim()));
        db.prepare(`
          INSERT OR IGNORE INTO project_agent_memory_versions(
            project_id, agent_id, revision, content, content_hash, source, reason
          ) VALUES(?, ?, 1, ?, ?, 'seed', '项目初始长期记忆')
        `).run(project.project_id, agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
        const overlay = db.prepare(`
          SELECT revision, content, content_hash, source, reason
          FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?
        `).get(project.project_id, agentId) as Pick<ProjectAgentOverlay, 'revision' | 'content' | 'content_hash' | 'source' | 'reason'>;
        const waitingForLegacyPrompt = project.is_default
          && overlay.source === 'migration'
          && overlay.reason === '多项目迁移：等待提取原项目 Overlay';
        const legacyPrompt = waitingForLegacyPrompt
          ? db.prepare('SELECT version, content FROM agent_prompts WHERE agent_id = ?').get(agentId) as { version: number; content: string } | undefined
          : undefined;
        const content = legacyPrompt?.content.trim() || overlay.content.trim() || definition.prompt.trim();
        const revision = Math.max(overlay.revision, legacyPrompt?.version || 1);
        if (content !== overlay.content || hash(content) !== overlay.content_hash || revision !== overlay.revision || waitingForLegacyPrompt) {
          db.prepare(`
            UPDATE project_agent_overlays
            SET revision = ?, content = ?, content_hash = ?,
                reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ? AND agent_id = ?
          `).run(
            revision,
            content,
            hash(content),
            waitingForLegacyPrompt ? '从历史项目 Prompt 迁移' : overlay.reason,
            project.project_id,
            agentId,
          );
        }
      }
    }
  }).immediate();

  for (const project of projects) {
    for (const agentId of FLOW_AGENT_IDS) {
      migrateLegacyDailyFiles(db, project.project_id, agentId);
      reconcileProjectOverlayCandidate(db, project.project_id, agentId);
      await reconcileAgentFiles(project.project_id, agentId);
    }
  }
  await writeManifest();
  return agentRuntimeRoot();
}

function migrateLegacyDailyFiles(db: Database.Database, projectId: string, agentId: FlowAgentId) {
  const sources = new Set<string>([join(agentRuntimeRoot(), 'agents', agentId, 'memory')]);
  const imports = db.prepare(`
    SELECT source_db_path FROM legacy_project_database_imports WHERE project_id = ?
  `).all(projectId) as { source_db_path: string }[];
  for (const item of imports) {
    const runtimeRoot = join(dirname(item.source_db_path), 'agent-runtime');
    sources.add(join(runtimeRoot, 'agents', agentId, 'memory'));
    const projectRoots = join(runtimeRoot, 'projects');
    if (existsSync(projectRoots)) {
      for (const name of readdirSync(projectRoots)) {
        sources.add(join(projectRoots, name, 'agents', agentId, 'memory'));
      }
    }
  }
  const target = join(agentDirectory(projectId, agentId), 'memory');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const source of sources) {
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source).filter((item) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(item))) {
      const destination = join(target, name);
      if (!existsSync(destination)) copyFileSync(join(source, name), destination);
    }
  }
}

async function reconcileAgentFiles(projectId: string, agentId: FlowAgentId) {
  const db = await databaseConnection();
  const state = db.prepare('SELECT * FROM project_agent_states WHERE project_id = ? AND agent_id = ?')
    .get(projectId, agentId) as { current_memory_revision: number };
  const overlay = projectOverlayCandidateInDb(db, projectId, agentId) || db.prepare(`
    SELECT * FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?
  `).get(projectId, agentId) as ProjectAgentOverlay;
  let memory = db.prepare(`
    SELECT * FROM project_agent_memory_versions
    WHERE project_id = ? AND agent_id = ? AND revision = ?
  `).get(projectId, agentId, state.current_memory_revision) as MemoryVersion;
  const directory = agentDirectory(projectId, agentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const memoryPath = join(directory, 'MEMORY.md');

  try {
    const local = memorySchema.parse(readFileSync(memoryPath, 'utf8'));
    if (hash(local) !== memory.content_hash) {
      await createMemoryVersion(projectId, agentId, local, 'local', '检测到本地 MEMORY.md 修改');
      memory = db.prepare(`
        SELECT memory.* FROM project_agent_memory_versions memory
        JOIN project_agent_states state
          ON state.project_id = memory.project_id AND state.agent_id = memory.agent_id
        WHERE memory.project_id = ? AND memory.agent_id = ? AND memory.revision = state.current_memory_revision
      `).get(projectId, agentId) as MemoryVersion;
    }
  } catch { /* Missing or invalid local files are rematerialized from SQLite. */ }
  materializeAgent(projectId, agentId, composePrompt(agentId, overlay.content), memory.content);
}

export async function listAgentProfiles(projectIdInput?: string) {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, projectIdInput);
  const profiles = db.prepare(`
    SELECT profile.*,
      state.current_memory_revision AS project_memory_revision,
      state.auto_evolve AS project_auto_evolve,
      overlay.revision AS project_overlay_revision,
      (SELECT COUNT(*) FROM project_agent_observations observation WHERE observation.project_id = ? AND observation.agent_id = profile.agent_id) AS observation_count,
      (SELECT COUNT(*) FROM project_agent_observations observation WHERE observation.project_id = ? AND observation.agent_id = profile.agent_id AND observation.status IN ('promoted_memory', 'promoted_prompt')) AS promoted_count,
      (SELECT COUNT(*) FROM execution_attempts attempt JOIN tasks task ON task.task_id = attempt.task_id WHERE task.project_id = ? AND attempt.agent = profile.agent_id) AS execution_count
    FROM agent_profiles profile
    JOIN project_agent_states state ON state.project_id = ? AND state.agent_id = profile.agent_id
    JOIN project_agent_overlays overlay ON overlay.project_id = state.project_id AND overlay.agent_id = profile.agent_id
    ORDER BY CASE profile.agent_id
      WHEN 'backlog-agent' THEN 1 WHEN 'story-splitter-agent' THEN 2
      WHEN 'analyst-agent' THEN 3 WHEN 'repro-agent' THEN 4
      WHEN 'dev-agent' THEN 5 WHEN 'test-agent' THEN 6
      WHEN 'review-agent' THEN 7 ELSE 8 END
  `).all(project.project_id, project.project_id, project.project_id, project.project_id) as (AgentProfile & {
    project_memory_revision: number;
    project_auto_evolve: number;
    project_overlay_revision: number;
    observation_count: number;
    promoted_count: number;
    execution_count: number;
  })[];
  return profiles.map((profile) => ({
    ...profile,
    current_prompt_version: profile.project_overlay_revision,
    current_memory_revision: profile.project_memory_revision,
    auto_evolve: profile.project_auto_evolve,
    candidate_prompt_version: projectOverlayCandidateInDb(db, project.project_id, profile.agent_id)?.revision || null,
    canary_remaining: projectOverlayCandidateInDb(db, project.project_id, profile.agent_id)?.remaining_runs || 0,
    project,
  }));
}

export async function getAgentProfile(agentIdInput: string, ensure = true, projectIdInput?: string) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const agentId = agentIdInput;
  if (ensure) await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, projectIdInput);
  const storedProfile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId) as AgentProfile | undefined;
  const state = db.prepare('SELECT * FROM project_agent_states WHERE project_id = ? AND agent_id = ?')
    .get(project.project_id, agentId) as { current_memory_revision: number; auto_evolve: number } | undefined;
  const projectOverlay = db.prepare('SELECT * FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?')
    .get(project.project_id, agentId) as ProjectAgentOverlay | undefined;
  const projectCandidate = projectOverlayCandidateInDb(db, project.project_id, agentId);
  const profile = storedProfile ? {
    ...storedProfile,
    current_prompt_version: projectOverlay?.revision || 1,
    current_memory_revision: state?.current_memory_revision || 1,
    auto_evolve: state?.auto_evolve ?? storedProfile.auto_evolve,
    candidate_prompt_version: projectCandidate?.revision || null,
    canary_remaining: projectCandidate?.remaining_runs || 0,
  } : undefined;
  if (!profile || !state || !projectOverlay) throw new Error(`项目 Agent Profile 不存在：${project.name} / ${agentId}`);
  const currentPrompt = rolePrompt(agentId);
  const currentMemory = db.prepare(`
    SELECT * FROM project_agent_memory_versions
    WHERE project_id = ? AND agent_id = ? AND revision = ?
  `).get(project.project_id, agentId, profile.current_memory_revision) as MemoryVersion;
  const memoryHistory = db.prepare(`
    SELECT * FROM project_agent_memory_versions
    WHERE project_id = ? AND agent_id = ? ORDER BY revision DESC
  `).all(project.project_id, agentId) as MemoryVersion[];
  const observations = db.prepare(`
    SELECT * FROM project_agent_observations WHERE project_id = ? AND agent_id = ?
    ORDER BY last_seen_at DESC, observation_id DESC LIMIT 100
  `).all(project.project_id, agentId) as AgentObservation[];
  const directory = agentDirectory(project.project_id, agentId);
  const dailyFiles = readdirSync(join(directory, 'memory')).filter((name) => name.endsWith('.md')).sort().reverse();
  const dailyMemories = dailyFiles.slice(0, 14).map((name) => {
    const content = readFileSync(join(directory, 'memory', name), 'utf8');
    return {
      name,
      content,
      observations: parseDailyMemoryObservations(content, currentMemory.content),
    };
  });
  return {
    definition: AGENT_PROFILE_DEFINITIONS[agentId],
    project,
    profile,
    currentPrompt,
    projectOverlay,
    candidatePrompt: projectCandidate,
    currentMemory,
    memoryHistory,
    observations,
    dailyFiles,
    dailyMemories,
    runtimeDirectory: directory,
  };
}

async function replaceProjectPrompt(
  projectId: string,
  agentId: FlowAgentId,
  contentInput: string,
  reason: string,
  source: ProjectAgentOverlay['source'] = 'human',
) {
  const content = overlaySchema.parse(contentInput);
  const db = await databaseConnection();
  const current = db.prepare('SELECT * FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?')
    .get(projectId, agentId) as ProjectAgentOverlay;
  if (current.content_hash === hash(content)) return current.revision;
  const revision = current.revision + 1;
  db.transaction(() => {
    db.prepare('DELETE FROM project_agent_overlay_candidates WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
    db.prepare(`
      UPDATE project_agent_overlays
      SET revision = ?, content = ?, content_hash = ?, source = ?, reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND agent_id = ?
    `).run(revision, content, hash(content), source, reason, projectId, agentId);
  })();
  await reconcileAgentFiles(projectId, agentId);
  await writeManifest();
  return revision;
}

async function createMemoryVersion(projectId: string, agentId: FlowAgentId, contentInput: string, source: MemoryVersion['source'], reason: string, evidence?: unknown) {
  const content = memorySchema.parse(contentInput) || '# Durable Memory';
  const db = await databaseConnection();
  const revision = ((db.prepare(`
    SELECT COALESCE(MAX(revision), 0) AS revision FROM project_agent_memory_versions
    WHERE project_id = ? AND agent_id = ?
  `).get(projectId, agentId) as { revision: number }).revision || 0) + 1;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO project_agent_memory_versions(project_id, agent_id, revision, content, content_hash, source, reason, evidence_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, agentId, revision, content, hash(content), source, reason, evidence ? JSON.stringify(evidence) : null);
    db.prepare(`
      UPDATE project_agent_states SET current_memory_revision = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND agent_id = ?
    `).run(revision, projectId, agentId);
  })();
  const selectedOverlay = projectOverlayCandidateInDb(db, projectId, agentId) || db.prepare(`
    SELECT * FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?
  `).get(projectId, agentId) as ProjectAgentOverlay;
  materializeAgent(projectId, agentId, composePrompt(agentId, selectedOverlay.content), content);
  await writeManifest();
  return revision;
}

export async function saveAgentPrompt(input: { projectId?: string; agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, input.projectId);
  const revision = await replaceProjectPrompt(project.project_id, input.agentId, String(input.content ?? ''), String(input.reason || '用户编辑项目 Agent Overlay'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function resetAgentPromptToSystemTemplate(input: { projectId?: string; agentId: string }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, input.projectId);
  const revision = await replaceProjectPrompt(
    project.project_id,
    input.agentId,
    AGENT_PROFILE_DEFINITIONS[input.agentId].prompt,
    `用户恢复全局角色模板 V${AGENT_PROMPT_SEED_REVISION}`,
    'human',
  );
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function saveAgentMemory(input: { projectId?: string; agentId: string; content: unknown; reason?: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, input.projectId);
  const revision = await createMemoryVersion(project.project_id, input.agentId, String(input.content ?? ''), 'human', String(input.reason || '用户编辑项目长期记忆'));
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function promoteDailyMemoryObservation(input: {
  projectId?: string;
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
  const db = await databaseConnection();
  const project = resolveProject(db, input.projectId);
  const detail = await getAgentProfile(input.agentId, false, project.project_id);
  const marker = `<!-- EVOLUTION:${fingerprint} -->`;
  if (detail.currentMemory.content.includes(marker)) return detail.currentMemory.revision;

  const path = join(agentDirectory(project.project_id, input.agentId), 'memory', memoryName);
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
    project.project_id,
    input.agentId,
    content,
    'human',
    `用户从 ${memoryName} 提升经验 ${fingerprint}`,
    { memoryName, executionId, fingerprint },
  );
  db.prepare(`
    UPDATE project_agent_observations SET status = 'promoted_memory', last_seen_at = CURRENT_TIMESTAMP
    WHERE project_id = ? AND agent_id = ? AND fingerprint = ?
  `).run(project.project_id, input.agentId, fingerprint);
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
  return revision;
}

export async function setAgentAutoEvolution(input: { projectId?: string; agentId: string; enabled: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error('未知 Agent');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, input.projectId);
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  db.prepare(`
    UPDATE project_agent_states SET auto_evolve = ?, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ? AND agent_id = ?
  `).run(enabled ? 1 : 0, project.project_id, input.agentId);
  try { revalidatePath('/agents', 'layout'); } catch { /* Non-request usage. */ }
}

function recentMemory(projectId: string, agentId: FlowAgentId) {
  const directory = join(agentDirectory(projectId, agentId), 'memory');
  const names = readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().slice(-2);
  let content = names.map((name) => `## ${name}\n${readFileSync(join(directory, name), 'utf8').trim()}`).join('\n\n');
  if (content.length > 6_000) content = content.slice(-6_000);
  return content;
}

export async function loadAgentRuntime(agentIdInput: string, pipeline?: string, projectIdInput?: string): Promise<AgentRuntimeContext> {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  await ensureAgentRuntimeWorkspace();
  const detail = await getAgentProfile(agentIdInput, false, projectIdInput);
  const selectedOverlay = detail.candidatePrompt || detail.projectOverlay;
  const composedPrompt = composePrompt(agentIdInput, selectedOverlay.content);
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
    projectId: detail.project.project_id,
    prompt,
    promptVersion: selectedOverlay.revision,
    promptTemplateVersion: AGENT_PROMPT_SEED_REVISION,
    promptHash: hash(prompt),
    promptStatus: detail.candidatePrompt ? 'candidate' : 'active',
    evolutionCandidateId: detail.candidatePrompt?.candidate_id || null,
    memory: detail.currentMemory.content,
    memoryRevision: detail.currentMemory.revision,
    memoryHash: detail.currentMemory.content_hash,
    recentMemory: recentMemory(detail.project.project_id, agentIdInput),
  };
}

export async function createProjectOverlayCandidate(input: {
  projectId: string;
  agentId: FlowAgentId;
  content: string;
  reason: string;
  evidence: unknown;
}) {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const current = db.prepare('SELECT * FROM project_agent_overlays WHERE project_id = ? AND agent_id = ?')
    .get(input.projectId, input.agentId) as ProjectAgentOverlay;
  if (projectOverlayCandidateInDb(db, input.projectId, input.agentId)) return null;
  const candidateId = randomUUID();
  db.prepare(`
    INSERT INTO project_agent_overlay_candidates(
      candidate_id, project_id, agent_id, revision, base_overlay_revision,
      content, content_hash, reason, evidence_json, remaining_runs
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 3)
  `).run(
    candidateId,
    input.projectId,
    input.agentId,
    current.revision + 1,
    current.revision,
    input.content,
    hash(input.content),
    input.reason,
    JSON.stringify(input.evidence),
  );
  return projectOverlayCandidateInDb(db, input.projectId, input.agentId);
}

export const agentProfileInternals = {
  createMemoryVersion,
  parseDailyMemoryObservations,
  agentDirectory,
  composePrompt,
  atomicWrite,
};
