import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import { evolutionObservationSchema, evolutionResultSchema, type EvolutionResult } from '../domain/agent-evolution';
import { databaseConnection, hash } from '../infrastructure/database';
import {
  agentProfileInternals,
  agentRuntimeRoot,
  ensureAgentRuntimeWorkspace,
  getAgentProfile,
} from './agent-profiles';

export type EvolutionEvidence = {
  executionId: string;
  taskId: string;
  storyIndex: number | null;
  agentId: string;
  attempt: number;
  promptVersion: number | null;
  result: { outcome: string; summary: string };
  applicationOutcome: string;
  harness?: { passed: boolean; summary: string } | null;
  diagnostics: string[];
};

const forbiddenEvolution = /(?:ignore\s+(?:all\s+)?previous|bypass|disable\s+(?:safety|validation|harness)|secret|password|api[_ -]?key|不要验证|绕过|取消限制|扩大权限)/i;

export function buildEvolutionPrompt(evidence: EvolutionEvidence) {
  return [
    '你是 Loop Engineering 的 Evolution Evaluator。你不执行产品工作、不修改文件、不调用工具，只分析给定的已完成执行证据。',
    '目标是发现能跨任务复用的操作经验，而不是解释当前业务需求。',
    '一次偶发错误只能 target=daily；只有明确稳定、可复用的项目经验才建议 memory；只有需要改变角色长期行为时才建议 prompt。',
    '不要提出扩大权限、绕过 Harness、修改状态机或输出协议的规则。不要记录密钥、用户数据、Task ID、绝对路径或未经验证的 Agent 自述。',
    '如果没有可复用经验，observations 返回空数组。',
    '',
    '执行证据：',
    JSON.stringify(evidence, null, 2),
    '',
    '只返回合法 JSON：',
    JSON.stringify({
      summary: '本轮是否产生可复用经验',
      observations: [{
        fingerprint: 'stable-kebab-case-key',
        category: 'tool-usage | reasoning | verification | output-contract | workflow-efficiency',
        summary: '可复用观察',
        guidance: '未来遇到什么条件时应采取什么做法',
        target: 'daily | memory | prompt',
        confidence: 0.8,
        reusable: true,
      }],
    }, null, 2),
  ].join('\n');
}

export async function beginEvolutionRun(evidence: EvolutionEvidence) {
  if (!isFlowAgentId(evidence.agentId)) return null;
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const profile = db.prepare('SELECT auto_evolve FROM agent_profiles WHERE agent_id = ?').get(evidence.agentId) as { auto_evolve: number } | undefined;
  if (!profile?.auto_evolve) return null;
  const existing = db.prepare('SELECT evolution_id, status FROM agent_evolution_runs WHERE execution_id = ?').get(evidence.executionId) as { evolution_id: string; status: string } | undefined;
  if (existing) return { evolutionId: existing.evolution_id, prompt: null };
  const evolutionId = randomUUID();
  db.prepare(`
    INSERT INTO agent_evolution_runs(evolution_id, execution_id, agent_id, status)
    VALUES(?, ?, ?, 'running')
  `).run(evolutionId, evidence.executionId, evidence.agentId);
  const evaluatorDirectory = join(agentRuntimeRoot(), 'evolution', 'evaluator');
  mkdirSync(evaluatorDirectory, { recursive: true, mode: 0o700 });
  return { evolutionId, prompt: buildEvolutionPrompt(evidence), evaluatorDirectory };
}

function appendDailyObservation(agentId: FlowAgentId, executionId: string, observation: EvolutionResult['observations'][number]) {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(agentProfileInternals.agentDirectory(agentId), 'memory', `${date}.md`);
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch { existing = `# ${date}\n`; }
  const marker = `<!-- execution:${executionId} fingerprint:${observation.fingerprint} -->`;
  if (existing.includes(marker)) return;
  const section = [
    '', marker,
    `## ${observation.summary}`,
    '',
    `- Fingerprint: \`${observation.fingerprint}\``,
    `- Category: ${observation.category}`,
    `- Target: ${observation.target}`,
    `- Confidence: ${observation.confidence.toFixed(2)}`,
    `- Guidance: ${observation.guidance}`,
    `- Evidence: execution \`${executionId}\``,
    '',
  ].join('\n');
  agentProfileInternals.atomicWrite(path, `${existing.trimEnd()}${section}`);
}

function safeEvolutionGuidance(value: string) {
  return value.length <= 1000 && !forbiddenEvolution.test(value);
}

async function promoteMemory(agentId: FlowAgentId, observation: EvolutionResult['observations'][number], evidence: EvolutionEvidence) {
  const detail = await getAgentProfile(agentId, false);
  const marker = `<!-- EVOLUTION:${observation.fingerprint} -->`;
  if (detail.currentMemory.content.includes(marker)) return;
  const content = [
    detail.currentMemory.content.trimEnd(),
    '',
    marker,
    `## ${observation.summary}`,
    '',
    observation.guidance,
    '',
    `适用范围：${observation.category}。证据：至少 3 次执行、2 个需求；最近 execution ${evidence.executionId}。`,
    '',
  ].join('\n');
  await agentProfileInternals.createMemoryVersion(agentId, content, 'evolution', `提升经验 ${observation.fingerprint}`, { executionId: evidence.executionId, fingerprint: observation.fingerprint });
}

async function createPromptCandidate(agentId: FlowAgentId, observation: EvolutionResult['observations'][number], evidence: EvolutionEvidence) {
  const db = await databaseConnection();
  const detail = await getAgentProfile(agentId, false);
  if (detail.profile.candidate_prompt_version) return;
  const marker = `<!-- EVOLUTION:${observation.fingerprint} -->`;
  if (detail.currentPrompt.content.includes(marker)) return;
  const addition = [marker, `- ${observation.guidance}`].join('\n');
  const content = `${detail.currentPrompt.content.trimEnd()}\n\n## Learned operating rules\n\n${addition}\n`;
  if (content.length > 20_000 || addition.length > 1_200 || !safeEvolutionGuidance(addition)) return;
  const version = ((db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM agent_prompt_versions WHERE agent_id = ?').get(agentId) as { version: number }).version || 0) + 1;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_prompt_versions(agent_id, version, content, content_hash, status, source, reason, evidence_json)
      VALUES(?, ?, ?, ?, 'candidate', 'evolution', ?, ?)
    `).run(agentId, version, content, hash(content.trim()), `自动演化：${observation.fingerprint}`, JSON.stringify({ executionId: evidence.executionId, fingerprint: observation.fingerprint }));
    db.prepare(`
      UPDATE agent_profiles
      SET candidate_prompt_version = ?, canary_remaining = 3, last_evolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(version, agentId);
    db.prepare("UPDATE agent_observations SET status = 'prompt_candidate' WHERE agent_id = ? AND fingerprint = ?").run(agentId, observation.fingerprint);
  })();
  agentProfileInternals.atomicWrite(join(agentProfileInternals.agentDirectory(agentId), 'PROMPT.md'), content);
  await agentProfileInternals.writeManifest();
}

async function storeObservation(evidence: EvolutionEvidence, observationInput: unknown) {
  if (!isFlowAgentId(evidence.agentId)) return;
  const observation = evolutionObservationSchema.parse(observationInput);
  if (!safeEvolutionGuidance(observation.guidance) || forbiddenEvolution.test(observation.summary)) return;
  appendDailyObservation(evidence.agentId, evidence.executionId, observation);
  const db = await databaseConnection();
  let row = db.prepare('SELECT * FROM agent_observations WHERE agent_id = ? AND fingerprint = ?').get(evidence.agentId, observation.fingerprint) as { observation_id: string; occurrence_count: number } | undefined;
  db.transaction(() => {
    if (!row) {
      row = { observation_id: randomUUID(), occurrence_count: 0 };
      db.prepare(`
        INSERT INTO agent_observations(
          observation_id, agent_id, fingerprint, category, summary, guidance,
          target, confidence, status, occurrence_count
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'observed', 0)
      `).run(row.observation_id, evidence.agentId, observation.fingerprint, observation.category, observation.summary, observation.guidance, observation.target, observation.confidence);
    }
    const occurrence = db.prepare(`
      INSERT OR IGNORE INTO agent_observation_occurrences(observation_id, execution_id, task_id, evidence_json)
      VALUES(?, ?, ?, ?)
    `).run(row.observation_id, evidence.executionId, evidence.taskId, JSON.stringify(evidence));
    if (occurrence.changes) {
      db.prepare(`
        UPDATE agent_observations
        SET occurrence_count = occurrence_count + 1, last_seen_at = CURRENT_TIMESTAMP,
            summary = ?, guidance = ?, confidence = MAX(confidence, ?), target = ?
        WHERE observation_id = ?
      `).run(observation.summary, observation.guidance, observation.confidence, observation.target, row.observation_id);
    }
  })();
  const promotion = db.prepare(`
    SELECT observation.occurrence_count, observation.confidence,
           COUNT(DISTINCT occurrence.task_id) AS task_count
    FROM agent_observations observation
    JOIN agent_observation_occurrences occurrence ON occurrence.observation_id = observation.observation_id
    WHERE observation.observation_id = ?
    GROUP BY observation.observation_id
  `).get(row!.observation_id) as { occurrence_count: number; confidence: number; task_count: number };
  if (!observation.reusable || promotion.occurrence_count < 3 || promotion.task_count < 2 || promotion.confidence < 0.75) return;
  if (observation.target === 'memory') {
    await promoteMemory(evidence.agentId, observation, evidence);
    db.prepare("UPDATE agent_observations SET status = 'promoted_memory' WHERE observation_id = ?").run(row!.observation_id);
  } else if (observation.target === 'prompt') {
    await createPromptCandidate(evidence.agentId, observation, evidence);
  }
}

export async function applyEvolutionResult(evolutionId: string, evidence: EvolutionEvidence, resultInput: unknown) {
  const result = evolutionResultSchema.parse(resultInput);
  const db = await databaseConnection();
  try {
    for (const observation of result.observations) await storeObservation(evidence, observation);
    db.prepare(`
      UPDATE agent_evolution_runs
      SET status = ?, evaluator_result_json = ?, finished_at = CURRENT_TIMESTAMP
      WHERE evolution_id = ?
    `).run(result.observations.length ? 'applied' : 'no_change', JSON.stringify(result), evolutionId);
  } catch (error) {
    db.prepare("UPDATE agent_evolution_runs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE evolution_id = ?").run(error instanceof Error ? error.message : String(error), evolutionId);
    throw error;
  }
}

export async function failEvolutionRun(evolutionId: string, error: string) {
  const db = await databaseConnection();
  db.prepare("UPDATE agent_evolution_runs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE evolution_id = ?").run(error, evolutionId);
}

export async function recordExecutionFailureObservation(input: { executionId: string; taskId: string; agentId: string; reason: string }) {
  if (!isFlowAgentId(input.agentId)) return;
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const profile = db.prepare('SELECT auto_evolve FROM agent_profiles WHERE agent_id = ?').get(input.agentId) as { auto_evolve: number } | undefined;
  if (!profile?.auto_evolve) return;
  const fingerprint = `executor-${hash(input.reason.replace(/\d+/g, '#').slice(0, 300)).slice(0, 16)}`;
  await storeObservation({
    executionId: input.executionId,
    taskId: input.taskId,
    storyIndex: null,
    agentId: input.agentId,
    attempt: 1,
    promptVersion: null,
    result: { outcome: 'failed', summary: input.reason },
    applicationOutcome: 'execution_failed',
    diagnostics: [input.reason],
  }, {
    fingerprint,
    category: 'workflow-efficiency',
    summary: 'Agent 执行器在返回结构化结果前失败',
    guidance: '把该失败保留为运行观察；只有确认属于稳定的 Agent 操作问题后，才能提升为长期规则。',
    target: 'daily',
    confidence: 0.65,
    reusable: false,
  });
}

export async function updatePromptCanary(agentIdInput: string, succeeded: boolean, executionId: string) {
  if (!isFlowAgentId(agentIdInput)) return;
  const agentId = agentIdInput;
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const detail = await getAgentProfile(agentId, false);
  const candidate = detail.candidatePrompt;
  if (!candidate) return;
  const attempt = db.prepare('SELECT evolution_candidate_id FROM execution_attempts WHERE execution_id = ?').get(executionId) as { evolution_candidate_id: string | null } | undefined;
  if (attempt?.evolution_candidate_id !== `${agentId}:prompt:v${candidate.version}`) return;
  let fingerprint = '';
  try { fingerprint = String(JSON.parse(candidate.evidence_json || '{}').fingerprint || ''); } catch { /* Invalid legacy evidence cannot alter observation state. */ }
  if (!succeeded) {
    db.transaction(() => {
      db.prepare("UPDATE agent_prompt_versions SET status = 'rolled_back' WHERE agent_id = ? AND version = ?").run(agentId, candidate.version);
      db.prepare('UPDATE agent_profiles SET candidate_prompt_version = NULL, canary_remaining = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?').run(agentId);
      if (fingerprint) db.prepare("UPDATE agent_observations SET status = 'rejected' WHERE agent_id = ? AND fingerprint = ?").run(agentId, fingerprint);
    })();
    agentProfileInternals.atomicWrite(join(agentProfileInternals.agentDirectory(agentId), 'PROMPT.md'), `${detail.currentPrompt.content.trim()}\n`);
    await agentProfileInternals.writeManifest();
    return;
  }
  const remaining = Math.max(0, detail.profile.canary_remaining - 1);
  if (remaining > 0) {
    db.prepare('UPDATE agent_profiles SET canary_remaining = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?').run(remaining, agentId);
    await agentProfileInternals.writeManifest();
    return;
  }
  db.transaction(() => {
    db.prepare("UPDATE agent_prompt_versions SET status = 'superseded' WHERE agent_id = ? AND version = ?").run(agentId, detail.currentPrompt.version);
    db.prepare("UPDATE agent_prompt_versions SET status = 'active', reason = COALESCE(reason, '') || ? WHERE agent_id = ? AND version = ?").run(`；Canary 通过，最终 execution ${executionId}`, agentId, candidate.version);
    if (fingerprint) db.prepare("UPDATE agent_observations SET status = 'promoted_prompt' WHERE agent_id = ? AND fingerprint = ?").run(agentId, fingerprint);
    db.prepare(`
      UPDATE agent_profiles
      SET current_prompt_version = ?, candidate_prompt_version = NULL, canary_remaining = 0,
          last_evolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(candidate.version, agentId);
  })();
  await agentProfileInternals.writeManifest();
}
