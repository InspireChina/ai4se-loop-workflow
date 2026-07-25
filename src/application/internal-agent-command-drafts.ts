import { randomBytes, randomUUID } from 'node:crypto';
import {
  evolutionObservationSchema,
  evolutionResultSchema,
  type EvolutionResult,
} from '../domain/agent-evolution';
import {
  softwareMaintenanceResultSchema,
  type SoftwareMaintenanceResult,
} from '../domain/software-maintenance';
import { databaseConnection, hash } from '../infrastructure/database';

type WorkType = 'evolution' | 'maintenance';
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

function assertSourceActive(db: Db, workType: WorkType, workId: string) {
  if (workType === 'evolution') {
    const row = db.prepare(`
      SELECT 1 FROM agent_evolution_runs WHERE evolution_id = ? AND status = 'running'
    `).get(workId);
    if (!row) throw new Error('当前 Prompt 演化工作不存在或已经结束');
    return;
  }
  const row = db.prepare(`
    SELECT 1 FROM software_maintenance_jobs WHERE job_id = ? AND status = 'running'
  `).get(workId);
  if (!row) throw new Error('当前软件维护工作不存在或已经结束');
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
  const agent = workType === 'evolution'
    ? 'prompt-evolution-agent'
    : 'software-maintenance-agent';
  db.transaction(() => {
    db.prepare(`
      INSERT INTO internal_agent_drafts(draft_id, work_type, work_id, agent)
      VALUES(?, ?, ?, ?)
    `).run(draftId, workType, workId, agent);
    if (workType === 'evolution') {
      db.prepare('INSERT INTO evolution_evaluator_drafts(draft_id) VALUES(?)').run(draftId);
    } else {
      db.prepare('INSERT INTO software_maintenance_drafts(draft_id) VALUES(?)').run(draftId);
    }
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

function maintenanceState(db: Db, draft: DraftRow) {
  const header = db.prepare(`
    SELECT outcome, fingerprint, classification, summary, root_cause, confidence, follow_up
    FROM software_maintenance_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    outcome: SoftwareMaintenanceResult['outcome'] | null;
    fingerprint: string | null;
    classification: SoftwareMaintenanceResult['classification'] | null;
    summary: string | null;
    root_cause: string | null;
    confidence: number | null;
    follow_up: string | null;
  };
  const files = db.prepare(`
    SELECT path, ordinal FROM software_maintenance_draft_files
    WHERE draft_id = ? ORDER BY ordinal, path
  `).all(draft.draft_id) as Array<{ path: string; ordinal: number }>;
  const tests = db.prepare(`
    SELECT test_key, command, passed, summary, ordinal
    FROM software_maintenance_draft_tests
    WHERE draft_id = ? ORDER BY ordinal, test_key
  `).all(draft.draft_id) as Array<{
    test_key: string;
    command: string;
    passed: number;
    summary: string;
    ordinal: number;
  }>;
  return { header, files, tests };
}

function maintenanceStatus(db: Db, draft: DraftRow) {
  const state = maintenanceState(db, draft);
  return [
    `软件维护草稿 · 变更 ${draft.change_seq}`,
    `结果：${state.header.outcome || '未填写'}`,
    `分类：${state.header.classification || '未填写'}`,
    `Fingerprint：${state.header.fingerprint || '未填写'}`,
    `摘要：${state.header.summary || '未填写'}`,
    `根因：${state.header.root_cause || '未填写'}`,
    `置信度：${state.header.confidence ?? '未填写'}`,
    `变更文件：${state.files.length}`,
    ...state.files.map((item) => `- ${item.path}`),
    `测试：${state.tests.length}`,
    ...state.tests.map((item) => `- ${item.test_key} · ${item.passed ? '通过' : '失败'} · ${item.command}`),
    '',
    '每次启动必须先查看本状态；使用稳定 test key 覆盖同一测试。',
  ].join('\n');
}

function maintenanceHelp() {
  return [
    '  maintenance status',
    '  maintenance outcome set --value <no_issue|fixed|not_repairable>',
    '  maintenance fingerprint set --value <stable-kebab-case-key>',
    '  maintenance classification set --value <loop_bug|executor_issue|target_repo_issue|expected_failure|insufficient_evidence>',
    '  maintenance summary set --text <结论>',
    '  maintenance root-cause set --text <证据支持的根因>',
    '  maintenance confidence set --value <0..1>',
    '  maintenance follow-up set --text <后续动作>',
    '  maintenance changed-file add --path <相对路径>',
    '  maintenance changed-file remove --path <相对路径>',
    '  maintenance test upsert --key <稳定 key> --command <命令> --passed <true|false> --summary <结果>',
    '  maintenance test remove --key <稳定 key>',
    '  maintenance complete',
  ].join('\n');
}

function buildMaintenanceResult(db: Db, draft: DraftRow) {
  const state = maintenanceState(db, draft);
  const result = softwareMaintenanceResultSchema.parse({
    outcome: state.header.outcome,
    fingerprint: state.header.fingerprint,
    classification: state.header.classification,
    summary: state.header.summary,
    rootCause: state.header.root_cause,
    confidence: state.header.confidence,
    changedFiles: state.files.map((item) => item.path),
    tests: state.tests.map((item) => ({
      command: item.command,
      passed: Boolean(item.passed),
      summary: item.summary,
    })),
    followUp: state.header.follow_up || '',
  });
  if (result.outcome !== 'fixed' && result.changedFiles.length) {
    throw new Error('未修复结果不能声明变更文件');
  }
  if (result.outcome === 'fixed') {
    if (!result.changedFiles.length) throw new Error('fixed 必须记录实际变更文件');
    if (!result.tests.length || result.tests.some((item) => !item.passed)) {
      throw new Error('fixed 必须至少记录一条通过的针对性测试，且不能保留失败测试');
    }
  }
  return result;
}

function setMaintenanceField(
  db: Db,
  draft: DraftRow,
  column: string,
  value: string | number,
) {
  db.prepare(`UPDATE software_maintenance_drafts SET ${column} = ? WHERE draft_id = ?`)
    .run(value, draft.draft_id);
  touch(db, draft.draft_id);
}

function runMaintenanceCommand(
  db: Db,
  draft: DraftRow,
  sessionId: string,
  command: string,
  flags: FlagMap,
) {
  if (command === 'help') return maintenanceHelp();
  if (command === 'maintenance status') {
    db.prepare(`
      UPDATE internal_agent_drafts
      SET status_viewed_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(sessionId, draft.draft_id);
    return maintenanceStatus(db, { ...draft, status_viewed_session_id: sessionId });
  }
  if (command === 'maintenance complete' && draft.status === 'submitted') {
    return '软件维护草稿已经提交，无需重复提交。';
  }
  assertViewed(draft, sessionId);
  if (command === 'maintenance outcome set') {
    const value = required(flags, 'value');
    if (!['no_issue', 'fixed', 'not_repairable'].includes(value)) {
      throw new Error('--value 必须是 no_issue、fixed 或 not_repairable');
    }
    setMaintenanceField(db, draft, 'outcome', value);
    return '维护结果已保存。';
  }
  if (command === 'maintenance fingerprint set') {
    setMaintenanceField(db, draft, 'fingerprint', bounded(required(flags, 'value'), 'Fingerprint', 120));
    return '维护 Fingerprint 已保存。';
  }
  if (command === 'maintenance classification set') {
    const value = required(flags, 'value');
    if (![
      'loop_bug', 'executor_issue', 'target_repo_issue',
      'expected_failure', 'insufficient_evidence',
    ].includes(value)) {
      throw new Error('--value 不是支持的软件维护分类');
    }
    setMaintenanceField(db, draft, 'classification', value);
    return '维护分类已保存。';
  }
  if (command === 'maintenance summary set') {
    setMaintenanceField(db, draft, 'summary', bounded(required(flags, 'text'), '维护摘要', 1000));
    return '维护摘要已保存。';
  }
  if (command === 'maintenance root-cause set') {
    setMaintenanceField(db, draft, 'root_cause', bounded(required(flags, 'text'), '根因', 3000));
    return '维护根因已保存。';
  }
  if (command === 'maintenance confidence set') {
    setMaintenanceField(db, draft, 'confidence', parseConfidence(required(flags, 'value')));
    return '维护置信度已保存。';
  }
  if (command === 'maintenance follow-up set') {
    setMaintenanceField(db, draft, 'follow_up', bounded(required(flags, 'text'), '后续动作', 2000));
    return '维护后续动作已保存。';
  }
  if (command === 'maintenance changed-file add') {
    const path = bounded(required(flags, 'path'), '变更路径', 300);
    const ordinal = nextOrdinal(db, 'software_maintenance_draft_files', draft.draft_id);
    db.prepare(`
      INSERT INTO software_maintenance_draft_files(draft_id, path, ordinal)
      VALUES(?, ?, ?) ON CONFLICT(draft_id, path) DO NOTHING
    `).run(draft.draft_id, path, ordinal);
    touch(db, draft.draft_id);
    return `维护变更文件 ${path} 已保存。`;
  }
  if (command === 'maintenance changed-file remove') {
    db.prepare(`
      DELETE FROM software_maintenance_draft_files WHERE draft_id = ? AND path = ?
    `).run(draft.draft_id, required(flags, 'path'));
    touch(db, draft.draft_id);
    return '维护变更文件已删除。';
  }
  if (command === 'maintenance test upsert') {
    const key = bounded(required(flags, 'key'), '测试 key', 120);
    const ordinal = nextOrdinal(db, 'software_maintenance_draft_tests', draft.draft_id);
    db.prepare(`
      INSERT INTO software_maintenance_draft_tests(
        draft_id, test_key, command, passed, summary, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, test_key) DO UPDATE SET
        command = excluded.command, passed = excluded.passed, summary = excluded.summary
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'command'), '测试命令', 300),
      parseBoolean(required(flags, 'passed'), '--passed') ? 1 : 0,
      bounded(required(flags, 'summary'), '测试结果', 1000),
      ordinal,
    );
    touch(db, draft.draft_id);
    return `维护测试 ${key} 已保存。`;
  }
  if (command === 'maintenance test remove') {
    db.prepare(`
      DELETE FROM software_maintenance_draft_tests WHERE draft_id = ? AND test_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touch(db, draft.draft_id);
    return '维护测试已删除。';
  }
  if (command === 'maintenance complete') {
    const result = buildMaintenanceResult(db, draft);
    db.prepare(`
      UPDATE internal_agent_drafts
      SET status = 'submitted', terminal_action = 'complete', result_json = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(JSON.stringify(result), draft.draft_id);
    return '软件维护结果已提交。';
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
  if (!['evolution', 'maintenance'].includes(input.workType)) {
    throw new Error(`不支持的内部 Agent 工作类型：${input.workType}`);
  }
  const db = await databaseConnection();
  const draft = assertAuthorized(db, input);
  const { command, flags } = parseArgs(input.args);
  if (input.workType === 'evolution') {
    return runEvolutionCommand(db, draft, input.sessionId, command, flags);
  }
  return runMaintenanceCommand(db, draft, input.sessionId, command, flags);
}

export async function readInternalAgentCommandSubmission<T extends WorkType>(
  workType: T,
  workId: string,
): Promise<T extends 'evolution' ? EvolutionResult | null : SoftwareMaintenanceResult | null> {
  const db = await databaseConnection();
  const draft = loadDraft(db, workType, workId);
  if (!draft?.result_json || draft.status !== 'submitted') return null as never;
  const value = JSON.parse(draft.result_json);
  return (workType === 'evolution'
    ? evolutionResultSchema.parse(value)
    : softwareMaintenanceResultSchema.parse(value)) as never;
}
