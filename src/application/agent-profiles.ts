import { discoverExternalAgents, externalAgentPath, loadExternalAgent } from '../infrastructure/external-agents';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGENT_PROFILE_DEFINITIONS, AGENT_PROMPT_SEED_REVISION, DEFAULT_AGENT_MEMORY, FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import { workspaceContextInDb, resolveWorkspaceContextInDb } from './workspace-context';

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
  source: 'system' | 'human' | 'evolution' | 'file';
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
  promptPath: string;
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

const memorySchema = z.string().trim().max(40_000);

export function agentRuntimeRoot() {
  return join(paths.dataDir, 'agent-runtime');
}

function agentDirectory(projectId: string, agentId: FlowAgentId) {
  return join(agentRuntimeRoot(), 'agents', agentId);
}

function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function materializeAgentMemory(projectId: string, agentId: FlowAgentId, memory: string) {
  const directory = agentDirectory(projectId, agentId);
  mkdirSync(join(directory, 'memory'), { recursive: true, mode: 0o700 });
  rmSync(join(directory, 'history'), { recursive: true, force: true });
  rmSync(join(directory, 'candidates'), { recursive: true, force: true });
  rmSync(join(directory, 'PROMPT.md'), { force: true });
  atomicWrite(join(directory, 'MEMORY.md'), `${memory.trim()}\n`);
}

type AgentDatabase = Awaited<ReturnType<typeof databaseConnection>>;
function resolveProject(db: AgentDatabase, projectIdInput?: string) {
  const project = projectIdInput ? resolveWorkspaceContextInDb(db, projectIdInput) : workspaceContextInDb(db);
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

export function isActiveProjectOverlayCandidateInDb(db: AgentDatabase, projectId: string, agentId: string, candidateId: string) {
  return false;
}

async function writeManifest() {
  const db = await databaseConnection();
  const profiles = db.prepare(`
    SELECT state.project_id, state.agent_id, 0 AS overlay_revision,
           state.current_memory_revision, state.auto_evolve, state.updated_at
    FROM project_agent_states state
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
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'observations'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentRuntimeRoot(), 'evolution', 'evaluations'), { recursive: true, mode: 0o700 });

  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO agent_profiles(agent_id, display_name, prompt_seed_revision)
    VALUES(?, ?, ?)
  `);
  const insertInitialMemory = db.prepare(`
    INSERT OR IGNORE INTO agent_memory_versions(
      agent_id, revision, content, content_hash, source, reason
    ) VALUES(?, 1, ?, ?, 'seed', '初始长期记忆')
  `);
  db.transaction(() => {
    for (const agentId of FLOW_AGENT_IDS) {
      const definition = AGENT_PROFILE_DEFINITIONS[agentId];
      insertProfile.run(agentId, definition.label, AGENT_PROMPT_SEED_REVISION);
      db.prepare(`
        UPDATE agent_profiles
        SET display_name = ?, current_prompt_version = ?, prompt_seed_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(definition.label, AGENT_PROMPT_SEED_REVISION, AGENT_PROMPT_SEED_REVISION, agentId);
      insertInitialMemory.run(agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));
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
          INSERT OR IGNORE INTO project_agent_memory_versions(
            project_id, agent_id, revision, content, content_hash, source, reason
          ) VALUES(?, ?, 1, ?, ?, 'seed', '项目初始长期记忆')
        `).run(project.project_id, agentId, DEFAULT_AGENT_MEMORY, hash(DEFAULT_AGENT_MEMORY.trim()));

      }
    }
  }).immediate();

  for (const project of projects) {
    for (const agentId of FLOW_AGENT_IDS) {
      await reconcileAgentFiles(project.project_id, agentId);
    }
  }
  await writeManifest();
  return agentRuntimeRoot();
}



async function reconcileAgentFiles(projectId: string, agentId: FlowAgentId) {
  const db = await databaseConnection();
  const state = db.prepare('SELECT * FROM project_agent_states WHERE project_id = ? AND agent_id = ?')
    .get(projectId, agentId) as { current_memory_revision: number };
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
  materializeAgentMemory(projectId, agentId, memory.content);
}

export async function listAgentProfiles(projectIdInput?: string) {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const project = resolveProject(db, projectIdInput);
  const profiles = db.prepare(`
    SELECT profile.*,
      state.current_memory_revision AS project_memory_revision,
      state.auto_evolve AS project_auto_evolve,
      0 AS project_overlay_revision,
      (SELECT COUNT(*) FROM project_agent_observations observation WHERE observation.project_id = ? AND observation.agent_id = profile.agent_id) AS observation_count,
      (SELECT COUNT(*) FROM project_agent_observations observation WHERE observation.project_id = ? AND observation.agent_id = profile.agent_id AND observation.status IN ('promoted_memory', 'promoted_prompt')) AS promoted_count,
      (SELECT COUNT(*) FROM execution_attempts attempt JOIN tasks task ON task.task_id = attempt.task_id WHERE task.project_id = ? AND attempt.agent = profile.agent_id) AS execution_count
    FROM agent_profiles profile
    JOIN project_agent_states state ON state.project_id = ? AND state.agent_id = profile.agent_id
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
  const detected = discoverExternalAgents(project.workspace_root);
  return profiles.map((profile) => ({
    ...profile,
    current_prompt_version: (() => { try { return loadExternalAgent(project.workspace_root, profile.agent_id).revision; } catch { return 0; } })(),
    externalAgentPath: detected.find((agent) => agent.id === profile.agent_id)?.path || null,
    externalAgentError: (() => { try { loadExternalAgent(project.workspace_root, profile.agent_id); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } })(),
    current_memory_revision: profile.project_memory_revision,
    auto_evolve: profile.project_auto_evolve,
    candidate_prompt_version: null,
    canary_remaining: 0,
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
  const projectCandidate: PromptCandidate | null = null;
  const profile = storedProfile ? {
    ...storedProfile,
    current_prompt_version: 0,
    current_memory_revision: state?.current_memory_revision || 1,
    auto_evolve: state?.auto_evolve ?? storedProfile.auto_evolve,
    candidate_prompt_version: null,
    canary_remaining: 0,
  } : undefined;
  if (!profile || !state) throw new Error(`项目 Agent Profile 不存在：${project.name} / ${agentId}`);
  let externalAgent: ReturnType<typeof loadExternalAgent> | null = null;
  let externalAgentError: string | null = null;
  try { externalAgent = loadExternalAgent(project.workspace_root, agentId); }
  catch (error) { externalAgentError = error instanceof Error ? error.message : String(error); }
  const currentPrompt: CurrentPrompt = { agent_id: agentId, template_version: 0, source: 'file', status: 'active', content: externalAgent?.prompt || '',
    content_hash: externalAgent?.hash || hash(''), version: externalAgent?.revision || 0,
    updated_at: externalAgent?.updatedAt || '', reason: externalAgentPath(project.workspace_root, agentId) };

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
    externalAgentPath: externalAgentPath(project.workspace_root, agentId),
    externalAgentError,
    projectOverlay: { agent_id: agentId, project_id: project.project_id, revision: currentPrompt.version, content: currentPrompt.content, content_hash: currentPrompt.content_hash, source: 'seed' as const, reason: currentPrompt.reason, updated_at: currentPrompt.updated_at },
    candidatePrompt: null as PromptCandidate | null,
    currentMemory,
    memoryHistory,
    observations,
    dailyFiles,
    dailyMemories,
    runtimeDirectory: directory,
  };
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
  materializeAgentMemory(projectId, agentId, content);
  await writeManifest();
  return revision;
}

export async function saveAgentPrompt(input: { projectId?: string; agentId: string; content: unknown; reason?: unknown }) {
  throw new Error('Agent Prompt 由外部 .omp/agents 文件管理，请直接编辑对应 Markdown 文件');
}

export async function resetAgentPromptToSystemTemplate(input: { projectId?: string; agentId: string }) {
  throw new Error('Agent Prompt 由外部 .omp/agents 文件管理，请直接编辑对应 Markdown 文件');
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

export async function loadAgentRuntime(agentIdInput: string, pipeline?: string, projectIdInput?: string, workspaceRoot?: string): Promise<AgentRuntimeContext> {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  await ensureAgentRuntimeWorkspace();
  const detail = await getAgentProfile(agentIdInput, false, projectIdInput);
  const externalAgent = loadExternalAgent(workspaceRoot || detail.project.workspace_root, agentIdInput);
  const composedPrompt = `# Agent Definition: ${externalAgent.path}\n相对文件引用以 ${externalAgent.directory} 为基准；按需读取其中引用的 Skill 和 Markdown 模板。\n\n${externalAgent.prompt}`;
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
    promptPath: externalAgent.path,
    promptVersion: externalAgent.revision,
    promptTemplateVersion: AGENT_PROMPT_SEED_REVISION,
    promptHash: hash(prompt),
    promptStatus: 'active',
    evolutionCandidateId: null,
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
  return null as PromptCandidate | null;
}

export const agentProfileInternals = {
  createMemoryVersion,
  parseDailyMemoryObservations,
  agentDirectory,
  atomicWrite,
};
