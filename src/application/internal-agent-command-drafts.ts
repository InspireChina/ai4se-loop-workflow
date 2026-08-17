import { randomBytes, randomUUID } from 'node:crypto';
import {
  evolutionObservationSchema,
  evolutionResultSchema,
  type EvolutionResult,
} from '../domain/agent-evolution';
import { databaseConnection, hash } from '../infrastructure/database';

type WorkType = 'evolution';
type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

type DraftRow = {
  draft_id: string;
  work_type: WorkType;
  work_id: string;
  agent: string;
  status: 'editing' | 'submitted';
  change_seq: number;
  active_session_id: string | null;
  command_token_hash: string | null;
  status_viewed_session_id: string | null;
  terminal_action: string | null;
  result_json: string | null;
};

function parseArgs(args: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} 必须提供值`);
    flags.set(name, next);
    index += 1;
  }
  return { command: positionals.join(' '), flags };
}

function required(flags: FlagMap, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function bounded(value: string, label: string, max: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return normalized;
}

function parseBoolean(value: string, label: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} 必须是 true 或 false`);
}

function parseConfidence(value: string) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('--confidence 必须是 0 到 1 之间的数字');
  }
  return confidence;
}

function nextOrdinal(db: Db, table: string, draftId: string) {
  return (db.prepare(`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM ${table} WHERE draft_id = ?
  `).get(draftId) as { value: number }).value;
}

function touch(db: Db, draftId: string) {
  db.prepare(`
    UPDATE internal_agent_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function loadDraft(db: Db, workType: WorkType, workId: string) {
  return db.prepare(`
    SELECT * FROM internal_agent_drafts WHERE work_type = ? AND work_id = ?
  `).get(workType, workId) as DraftRow | undefined;
}

function assertSourceActive(db: Db, _workType: WorkType, workId: string) {
  const row = db.prepare(`
    SELECT 1 FROM agent_evolution_runs WHERE evolution_id = ? AND status = 'running'
  `).get(workId);
  if (!row) throw new Error('当前 Prompt 演化工作不存在或已经结束');
}

function assertAuthorized(
  db: Db,
  input: { workType: WorkType; workId: string; sessionId: string; token: string },
) {
  assertSourceActive(db, input.workType, input.workId);
  const draft = loadDraft(db, input.workType, input.workId);
  if (!draft) throw new Error('当前内部 Agent 草稿不存在');
  if (draft.active_session_id !== input.sessionId) throw new Error('当前内部 Agent 会话已经失效');
  if (!draft.command_token_hash || hash(input.token) !== draft.command_token_hash) {
    throw new Error('当前内部 Agent 命令凭证无效');
  }
  return draft;
}

function assertViewed(draft: DraftRow, sessionId: string) {
  if (draft.status_viewed_session_id !== sessionId) {
    throw new Error(`本次启动尚未查看草稿状态。请先执行 ${draft.work_type} status`);
  }
  if (draft.status !== 'editing') throw new Error('当前草稿已经提交');
}

function createDraft(db: Db, workType: WorkType, workId: string) {
  const draftId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO internal_agent_drafts(draft_id, work_type, work_id, agent)
      VALUES(?, ?, ?, 'prompt-evolution-agent')
    `).run(draftId, workType, workId);
    db.prepare('INSERT INTO evolution_evaluator_drafts(draft_id) VALUES(?)').run(draftId);
  })();
  return loadDraft(db, workType, workId)!;
}

export async function issueInternalAgentCommandToken(workType: WorkType, workId: string) {
  const db = await databaseConnection();
  assertSourceActive(db, workType, workId);
  const draft = loadDraft(db, workType, workId) || createDraft(db, workType, workId);
  const sessionId = randomUUID();
  const token = randomBytes(32).toString('hex');
  db.prepare(`
    UPDATE internal_agent_drafts
    SET active_session_id = ?, command_token_hash = ?,
        status_viewed_session_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(sessionId, hash(token), draft.draft_id);
  return { sessionId, token };
}

function evolutionState(db: Db, draft: DraftRow) {
  const header = db.prepare(`
    SELECT summary FROM evolution_evaluator_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as { summary: string | null };
  const observations = db.prepare(`
    SELECT observation_key, fingerprint, category, summary, guidance, target,
           confidence, reusable, evidence_comment_ids_json, ordinal
    FROM evolution_evaluator_observations
    WHERE draft_id = ? ORDER BY ordinal, observation_key
  `).all(draft.draft_id) as Array<{
    observation_key: string;
    fingerprint: string;
    category: EvolutionResult['observations'][number]['category'];
    summary: string;
    guidance: string;
    target: EvolutionResult['observations'][number]['target'];
    confidence: number;
    reusable: number;
    evidence_comment_ids_json: string;
    ordinal: number;
  }>;
  return { header, observations };
}

function evolutionStatus(db: Db, draft: DraftRow) {
  const state = evolutionState(db, draft);
  return [
    `Prompt 演化草稿 · 变更 ${draft.change_seq}`,
    `摘要：${state.header.summary || '未填写'}`,
    `观察：${state.observations.length}/5`,
    ...state.observations.map((item) =>
      `- ${item.observation_key} · ${item.fingerprint} · ${item.target} · confidence=${item.confidence}`),
    '',
    '每次启动必须先查看本状态；使用稳定 observation key 覆盖同一观察。',
  ].join('\n');
}

function evolutionHelp() {
  return [
    '  evolution status',
    '  evolution summary set --text <本轮结论>',
    '  evolution observation upsert --key <稳定 key> --fingerprint <kebab-case> --category <tool-usage|reasoning|verification|output-contract|workflow-efficiency> --summary <观察> --guidance <未来做法> --target <daily|memory|prompt> --confidence <0..1> --reusable <true|false> --comment-ids <逗号分隔 UUID；无引用时传 none>',
    '  evolution observation remove --key <稳定 key>',
    '  evolution complete',
  ].join('\n');
}

function buildEvolutionResult(db: Db, draft: DraftRow) {
  const state = evolutionState(db, draft);
  return evolutionResultSchema.parse({
    summary: state.header.summary,
    observations: state.observations.map((item) => ({
      fingerprint: item.fingerprint,
      category: item.category,
      summary: item.summary,
      guidance: item.guidance,
      target: item.target,
      confidence: item.confidence,
      reusable: Boolean(item.reusable),
      evidenceCommentIds: JSON.parse(item.evidence_comment_ids_json),
    })),
  });
}

function runEvolutionCommand(
  db: Db,
  draft: DraftRow,
  sessionId: string,
  command: string,
  flags: FlagMap,
) {
  if (command === 'help') return evolutionHelp();
  if (command === 'evolution status') {
    db.prepare(`
      UPDATE internal_agent_drafts
      SET status_viewed_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(sessionId, draft.draft_id);
    return evolutionStatus(db, { ...draft, status_viewed_session_id: sessionId });
  }
  if (command === 'evolution complete' && draft.status === 'submitted') {
    return 'Prompt 演化草稿已经提交，无需重复提交。';
  }
  assertViewed(draft, sessionId);
  if (command === 'evolution summary set') {
    db.prepare('UPDATE evolution_evaluator_drafts SET summary = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '演化摘要', 1000), draft.draft_id);
    touch(db, draft.draft_id);
    return '演化摘要已保存。';
  }
  if (command === 'evolution observation upsert') {
    const key = bounded(required(flags, 'key'), '观察 key', 120);
    const commentIdsValue = required(flags, 'comment-ids');
    const commentIds = commentIdsValue === 'none'
      ? []
      : commentIdsValue.split(',').map((item) => item.trim()).filter(Boolean);
    const observation = evolutionObservationSchema.parse({
      fingerprint: bounded(required(flags, 'fingerprint'), '观察 fingerprint', 120),
      category: required(flags, 'category'),
      summary: bounded(required(flags, 'summary'), '观察摘要', 500),
      guidance: bounded(required(flags, 'guidance'), '操作建议', 1000),
      target: required(flags, 'target'),
      confidence: parseConfidence(required(flags, 'confidence')),
      reusable: parseBoolean(required(flags, 'reusable'), '--reusable'),
      evidenceCommentIds: commentIds,
    });
    const ordinal = nextOrdinal(db, 'evolution_evaluator_observations', draft.draft_id);
    db.prepare(`
      INSERT INTO evolution_evaluator_observations(
        draft_id, observation_key, fingerprint, category, summary, guidance,
        target, confidence, reusable, evidence_comment_ids_json, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, observation_key) DO UPDATE SET
        fingerprint = excluded.fingerprint, category = excluded.category,
        summary = excluded.summary, guidance = excluded.guidance,
        target = excluded.target, confidence = excluded.confidence,
        reusable = excluded.reusable,
        evidence_comment_ids_json = excluded.evidence_comment_ids_json
    `).run(
      draft.draft_id,
      key,
      observation.fingerprint,
      observation.category,
      observation.summary,
      observation.guidance,
      observation.target,
      observation.confidence,
      observation.reusable ? 1 : 0,
      JSON.stringify(observation.evidenceCommentIds),
      ordinal,
    );
    touch(db, draft.draft_id);
    return `演化观察 ${key} 已保存。`;
  }
  if (command === 'evolution observation remove') {
    db.prepare(`
      DELETE FROM evolution_evaluator_observations
      WHERE draft_id = ? AND observation_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touch(db, draft.draft_id);
    return '演化观察已删除。';
  }
  if (command === 'evolution complete') {
    const result = buildEvolutionResult(db, draft);
    db.prepare(`
      UPDATE internal_agent_drafts
      SET status = 'submitted', terminal_action = 'complete', result_json = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(JSON.stringify(result), draft.draft_id);
    return 'Prompt 演化结果已提交。';
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

export async function runInternalAgentCommand(input: {
  workType: WorkType;
  workId: string;
  sessionId: string;
  token: string;
  args: string[];
}) {
  if (input.workType !== 'evolution') {
    throw new Error(`不支持的内部 Agent 工作类型：${input.workType}`);
  }
  const db = await databaseConnection();
  const draft = assertAuthorized(db, input);
  const { command, flags } = parseArgs(input.args);
  return runEvolutionCommand(db, draft, input.sessionId, command, flags);
}

export async function readInternalAgentCommandSubmission(
  workType: WorkType,
  workId: string,
): Promise<EvolutionResult | null> {
  const db = await databaseConnection();
  const draft = loadDraft(db, workType, workId);
  if (!draft?.result_json || draft.status !== 'submitted') return null;
  return evolutionResultSchema.parse(JSON.parse(draft.result_json));
}
