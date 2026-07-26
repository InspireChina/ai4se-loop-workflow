import { createHash } from 'node:crypto';
import { agentResultSchema } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type ReviewDraftRow = {
  draft_id: string;
  draft_version: number;
  task_id: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

export type ReviewExecutionRow = {
  execution_id: string;
  task_id: string;
  pipeline: string;
  input_json: string;
};

const SECTION_KINDS = [
  'outcome',
  'scope',
  'decisions',
  'implementation',
  'verification',
  'deviations',
  'risks',
  'feedback',
] as const;

type SectionKind = typeof SECTION_KINDS[number];
type ReviewMode = 'closure' | 'report_correction';
type SubjectKind =
  | 'intent'
  | 'target'
  | 'impact'
  | 'acceptance'
  | 'delivery_unit'
  | 'feedback_acceptance';
type GapKind = 'missing_evidence' | 'fact_conflict' | 'unresolved_obligation';

const REQUIRED_REPORT_SECTIONS: SectionKind[] = [
  'outcome',
  'scope',
  'implementation',
  'verification',
  'risks',
];

const DEFAULT_HEADINGS: Record<SectionKind, string> = {
  outcome: '原始目标与最终结果',
  scope: '实际交付范围',
  decisions: '关键决策与取舍',
  implementation: '实现与代码变化',
  verification: '验收与验证证据',
  deviations: '偏差与妥协',
  risks: '已知限制与后续建议',
  feedback: '评论与反馈处理',
};

type ContextResource = {
  ref: string;
  kind: string;
  status: string;
  revision?: number | null;
  deliveryUnit?: number | null;
  content: unknown;
};

type RequiredSubject = {
  subject_ref: string;
  subject_kind: SubjectKind;
  content: string;
  source_ref: string | null;
  contract_ref: string | null;
  story_index: number | null;
  subject_hash?: string;
  ordinal: number;
};

type ReconciliationEvidence = {
  ref: string;
  revision: number | null;
  hash: string;
};

type Reconciliation = {
  reconciliation_key: string;
  subject_ref: string;
  result: string;
  ordinal: number;
  evidence: ReconciliationEvidence[];
};

type Gap = {
  gap_key: string;
  subject_ref: string;
  gap_kind: GapKind;
  reason: string;
  boundary: string;
  status: 'active' | 'resolved' | 'forwarded';
  resolution: string | null;
  forwarded_story_index: number | null;
  ordinal: number;
};

function required(flags: FlagMap, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function bounded(value: string, label: string, max = 4000) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return normalized;
}

function sectionKind(flags: FlagMap) {
  const value = required(flags, 'kind') as SectionKind;
  if (!SECTION_KINDS.includes(value)) {
    throw new Error(`--kind 必须是 ${SECTION_KINDS.join('、')}`);
  }
  return value;
}

function gapKind(flags: FlagMap) {
  const value = required(flags, 'kind') as GapKind;
  const allowed: GapKind[] = [
    'missing_evidence',
    'fact_conflict',
    'unresolved_obligation',
  ];
  if (!allowed.includes(value)) {
    throw new Error(`--kind 必须是 ${allowed.join('、')}`);
  }
  return value;
}

function parseEvidenceRefs(flags: FlagMap) {
  const refs = required(flags, 'evidence')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!refs.length) throw new Error('至少需要一个 --evidence 引用');
  return [...new Set(refs)];
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function subjectFingerprint(subject: RequiredSubject) {
  return stableHash({
    kind: subject.subject_kind,
    content: subject.content,
    sourceRef: subject.source_ref,
    contractRef: subject.contract_ref,
    storyIndex: subject.story_index,
  });
}

function resourceFingerprint(resource: ContextResource) {
  return stableHash({
    ref: resource.ref,
    kind: resource.kind,
    status: resource.status,
    revision: resource.revision ?? null,
    deliveryUnit: resource.deliveryUnit ?? null,
    content: resource.content,
  });
}

function nextOrdinal(db: Db, table: string, draftId: string) {
  return (db.prepare(`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS value
    FROM ${table} WHERE draft_id = ?
  `).get(draftId) as { value: number }).value;
}

function touchDraft(db: Db, draftId: string) {
  db.prepare(`
    UPDATE agent_work_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function assertViewed(draft: ReviewDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 review status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function executionInput(execution: ReviewExecutionRow) {
  try {
    return JSON.parse(execution.input_json) as {
      delegation?: {
        feedbackGroupId?: string | null;
        totalStories?: number;
        reviewRevision?: number;
        reviewDocumentId?: string | null;
      };
      contextSnapshot?: {
        resources?: ContextResource[];
      };
    };
  } catch {
    throw new Error('当前 execution 的输入快照无法读取');
  }
}

function visibleResources(execution: ReviewExecutionRow) {
  return executionInput(execution).contextSnapshot?.resources || [];
}

function isIndependentTestEvidence(resource: ContextResource) {
  if (resource.kind === 'execution') {
    const content = resource.content as {
      agent?: string;
      status?: string;
      outcome?: string;
      verdict?: string;
    } | null;
    return content?.agent === 'test-agent'
      && ['applied', 'completed'].includes(content.status || resource.status)
      && content.outcome === 'completed'
      && content.verdict === 'passed';
  }
  return false;
}

function taskHeader(db: Db, taskId: string) {
  const task = db.prepare(`
    SELECT title, description, agile_status, current_subagent, total_stories,
           closure_status, review_document_id, review_revision
    FROM tasks WHERE task_id = ?
  `).get(taskId) as {
    title: string;
    description: string | null;
    agile_status: string;
    current_subagent: string | null;
    total_stories: number;
    closure_status: string;
    review_document_id: string | null;
    review_revision: number;
  } | undefined;
  if (!task) throw new Error('当前需求不存在');
  return task;
}

function latestRequirementContextDraft(db: Db, taskId: string) {
  return db.prepare(`
    SELECT awd.draft_id, rcd.intent
    FROM agent_work_drafts awd
    JOIN requirement_context_drafts rcd ON rcd.draft_id = awd.draft_id
    WHERE awd.task_id = ?
      AND awd.draft_type = 'requirement_context'
      AND awd.status = 'submitted'
      AND awd.terminal_action = 'complete'
    ORDER BY awd.submitted_at DESC, awd.draft_version DESC
    LIMIT 1
  `).get(taskId) as { draft_id: string; intent: string | null } | undefined;
}

function closureSubjects(db: Db, draft: ReviewDraftRow): RequiredSubject[] {
  const subjects: RequiredSubject[] = [];
  let ordinal = 1;
  const context = latestRequirementContextDraft(db, draft.task_id);
  const task = taskHeader(db, draft.task_id);
  if (context?.intent?.trim()) {
    subjects.push({
      subject_ref: `REQUIREMENT_CONTEXT:${context.draft_id}:intent`,
      subject_kind: 'intent',
      content: context.intent.trim(),
      source_ref: `REQUIREMENT_CONTEXT:${context.draft_id}:intent`,
      contract_ref: null,
      story_index: null,
      ordinal: ordinal++,
    });
    const targets = db.prepare(`
      SELECT assertion_key, statement
      FROM requirement_context_assertions
      WHERE draft_id = ? AND perspective = 'target' AND lifecycle_status = 'active'
      ORDER BY ordinal, assertion_key
    `).all(context.draft_id) as { assertion_key: string; statement: string }[];
    for (const item of targets) {
      const ref = `REQUIREMENT_CONTEXT:${context.draft_id}:assertion:${item.assertion_key}`;
      subjects.push({
        subject_ref: ref,
        subject_kind: 'target',
        content: item.statement,
        source_ref: ref,
        contract_ref: null,
        story_index: null,
        ordinal: ordinal++,
      });
    }
    const impacts = db.prepare(`
      SELECT impact_key, statement, disposition, rationale
      FROM requirement_context_impacts
      WHERE draft_id = ? AND lifecycle_status = 'active'
        AND disposition IN ('change', 'preserve', 'technical')
      ORDER BY ordinal, impact_key
    `).all(context.draft_id) as {
      impact_key: string;
      statement: string;
      disposition: string;
      rationale: string;
    }[];
    for (const item of impacts) {
      const ref = `REQUIREMENT_CONTEXT:${context.draft_id}:impact:${item.impact_key}`;
      subjects.push({
        subject_ref: ref,
        subject_kind: 'impact',
        content: `[${item.disposition}] ${item.statement}\n原因：${item.rationale}`,
        source_ref: ref,
        contract_ref: null,
        story_index: null,
        ordinal: ordinal++,
      });
    }
    const acceptance = db.prepare(`
      SELECT acceptance_key, content
      FROM requirement_context_acceptance_items
      WHERE draft_id = ? AND lifecycle_status = 'active'
      ORDER BY ordinal, acceptance_key
    `).all(context.draft_id) as { acceptance_key: string; content: string }[];
    for (const item of acceptance) {
      const ref = `REQUIREMENT_CONTEXT:${context.draft_id}:acceptance:${item.acceptance_key}`;
      subjects.push({
        subject_ref: ref,
        subject_kind: 'acceptance',
        content: item.content,
        source_ref: ref,
        contract_ref: null,
        story_index: null,
        ordinal: ordinal++,
      });
    }
  } else {
    // A requirement created before the progressive context protocol still gets
    // one explicit goal to reconcile. New requirements normally use the
    // immutable Requirement Context refs above.
    subjects.push({
      subject_ref: `REQUIREMENT:${draft.task_id}:intent`,
      subject_kind: 'intent',
      content: task.description?.trim() || task.title,
      source_ref: null,
      contract_ref: null,
      story_index: null,
      ordinal: ordinal++,
    });
  }

  const units = db.prepare(`
    SELECT
      s.story_index, s.unit_key, s.title, s.actor, s.trigger_condition,
      s.observable_outcome, s.acceptance,
      ss.spec_id, ss.revision
    FROM stories s
    LEFT JOIN story_specs ss ON ss.spec_id = (
      SELECT latest.spec_id
      FROM story_specs latest
      WHERE latest.task_id = s.task_id
        AND latest.story_index = s.story_index
        AND latest.status = 'resolved'
      ORDER BY latest.revision DESC
      LIMIT 1
    )
    WHERE s.task_id = ?
    ORDER BY s.story_index
  `).all(draft.task_id) as {
    story_index: number;
    unit_key: string | null;
    title: string;
    actor: string | null;
    trigger_condition: string | null;
    observable_outcome: string | null;
    acceptance: string | null;
    spec_id: string | null;
    revision: number | null;
  }[];
  for (const unit of units) {
    const contractRef = unit.spec_id && unit.revision
      ? `SPEC:${unit.spec_id}:r${unit.revision}`
      : null;
    subjects.push({
      subject_ref: `DELIVERY_UNIT:${draft.task_id}:${unit.story_index}`,
      subject_kind: 'delivery_unit',
      content: [
        `交付单元 ${unit.story_index}：${unit.title}`,
        `稳定 key：${unit.unit_key || '未设置'}`,
        `参与者：${unit.actor || '未设置'}`,
        `触发条件：${unit.trigger_condition || '未设置'}`,
        `可观察结果：${unit.observable_outcome || '未设置'}`,
        `验收语义：${unit.acceptance || '未设置'}`,
      ].join('\n'),
      source_ref: null,
      contract_ref: contractRef,
      story_index: unit.story_index,
      ordinal: ordinal++,
    });
  }

  const feedbackGroups = db.prepare(`
    SELECT fg.group_id, fg.title, fg.reason, fg.acceptance_json
    FROM feedback_groups fg
    JOIN feedback_batches fb ON fb.batch_id = fg.batch_id
    WHERE fb.task_id = ?
      AND fb.status = 'completed'
      AND fg.status = 'completed'
      AND fg.work_type IN (
        'bug', 'behavior_change', 'scope_addition', 'technical_change'
      )
    ORDER BY fb.created_at, fg.group_order, fg.created_at
  `).all(draft.task_id) as {
    group_id: string;
    title: string | null;
    reason: string;
    acceptance_json: string;
  }[];
  for (const group of feedbackGroups) {
    let acceptance: unknown;
    try {
      acceptance = JSON.parse(group.acceptance_json);
    } catch {
      throw new Error(`反馈工作组 ${group.group_id} 的验收语义不是合法 JSON`);
    }
    if (!Array.isArray(acceptance)) {
      throw new Error(`反馈工作组 ${group.group_id} 的验收语义必须是数组`);
    }
    acceptance.forEach((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`反馈工作组 ${group.group_id} 包含无效验收语义`);
      }
      subjects.push({
        subject_ref: `FEEDBACK_GROUP:${group.group_id}:acceptance:${index + 1}`,
        subject_kind: 'feedback_acceptance',
        content: `${group.title || group.reason}：${item.trim()}`,
        source_ref: `FEEDBACK_GROUP:${group.group_id}`,
        contract_ref: null,
        story_index: null,
        ordinal: ordinal++,
      });
    });
  }
  return subjects;
}

function reportCorrectionSubjects(
  db: Db,
  draft: ReviewDraftRow,
  execution: ReviewExecutionRow,
): RequiredSubject[] {
  const groupId = executionInput(execution).delegation?.feedbackGroupId;
  if (!groupId) throw new Error('报告更正缺少反馈工作组');
  const group = db.prepare(`
    SELECT fg.group_id, fg.title, fg.reason, fg.acceptance_json
    FROM feedback_groups fg
    JOIN feedback_batches fb ON fb.batch_id = fg.batch_id
    WHERE fg.group_id = ? AND fb.task_id = ? AND fg.work_type = 'report_correction'
  `).get(groupId, draft.task_id) as {
    group_id: string;
    title: string | null;
    reason: string;
    acceptance_json: string;
  } | undefined;
  if (!group) throw new Error('报告更正关联的反馈工作组不存在或类型不正确');
  let acceptance: unknown;
  try {
    acceptance = JSON.parse(group.acceptance_json);
  } catch {
    throw new Error('报告更正工作组的验收语义不是合法 JSON');
  }
  if (!Array.isArray(acceptance)) {
    throw new Error('报告更正工作组的验收语义必须是数组');
  }
  return [{
    subject_ref: `FEEDBACK_GROUP:${group.group_id}:report_correction`,
    subject_kind: 'feedback_acceptance',
    content: [
      `报告更正：${group.title || group.reason}`,
      `原因：${group.reason}`,
      ...acceptance.map((item, index) => `${index + 1}. ${String(item)}`),
    ].join('\n'),
    source_ref: `FEEDBACK_GROUP:${group.group_id}`,
    contract_ref: null,
    story_index: null,
    ordinal: 1,
  }];
}

function cloneLatestReportSections(
  db: Db,
  draft: ReviewDraftRow,
  baselineDocumentId: string,
) {
  const sectionCount = (db.prepare(`
    SELECT COUNT(*) AS value FROM review_sections WHERE draft_id = ?
  `).get(draft.draft_id) as { value: number }).value;
  if (sectionCount) return;
  const source = db.prepare(`
    SELECT awd.draft_id
    FROM agent_work_drafts awd
    JOIN review_drafts rd ON rd.draft_id = awd.draft_id
    JOIN agent_results ar
      ON ar.execution_id = awd.terminal_execution_id
      AND ar.agent = 'review-agent'
      AND ar.application_status = 'applied'
      AND ar.effect_outcome = 'advanced'
    JOIN documents baseline
      ON baseline.document_id = ?
      AND baseline.task_id = awd.task_id
      AND json_extract(ar.result_json, '$.artifact.content') = baseline.content
    WHERE awd.task_id = ?
      AND awd.draft_id <> ?
      AND awd.status = 'submitted'
      AND awd.terminal_action = 'complete'
      AND EXISTS (
        SELECT 1 FROM review_sections rs WHERE rs.draft_id = awd.draft_id
      )
    ORDER BY awd.submitted_at DESC, awd.draft_version DESC
    LIMIT 1
  `).get(
    baselineDocumentId,
    draft.task_id,
    draft.draft_id,
  ) as { draft_id: string } | undefined;
  if (!source) {
    throw new Error('报告更正缺少可继承的结构化结卡报告基线');
  }
  db.prepare(`
    INSERT INTO review_sections(draft_id, section_kind, content)
    SELECT ?, section_kind, content
    FROM review_sections WHERE draft_id = ?
  `).run(draft.draft_id, source.draft_id);
}

function assertExecutionStillCurrent(
  db: Db,
  draft: ReviewDraftRow,
  execution: ReviewExecutionRow,
  header: {
    mode: ReviewMode;
    baseline_review_document_id: string | null;
    baseline_review_revision: number | null;
  },
) {
  const task = taskHeader(db, draft.task_id);
  const delegation = executionInput(execution).delegation || {};
  if (header.mode === 'closure') {
    if (
      task.agile_status !== 'in review'
      || task.current_subagent !== 'review-agent'
      || task.closure_status !== 'none'
    ) {
      throw new Error('需求已离开普通结卡状态，请结束本轮并等待重新派发');
    }
    if (
      delegation.totalStories !== undefined
      && delegation.totalStories !== task.total_stories
    ) {
      throw new Error('交付单元数量已变化，当前 Review execution 已过期，请重新派发');
    }
    if (
      delegation.reviewRevision !== undefined
      && delegation.reviewRevision !== task.review_revision
    ) {
      throw new Error('结卡报告版本已变化，当前 Review execution 已过期，请重新派发');
    }
    return task;
  }
  if (
    task.agile_status !== 'in feedback'
  ) {
    throw new Error('需求已离开报告更正状态，请结束本轮并等待重新派发');
  }
  if (
    !delegation.reviewDocumentId
    || delegation.reviewDocumentId !== task.review_document_id
    || delegation.reviewRevision !== task.review_revision
  ) {
    throw new Error('结卡报告基线已变化，当前报告更正 execution 已过期，请重新派发');
  }
  if (
    (header.baseline_review_document_id
      && header.baseline_review_document_id !== task.review_document_id)
    || (header.baseline_review_revision
      && header.baseline_review_revision !== task.review_revision)
  ) {
    throw new Error('草稿绑定的结卡报告基线已变化，请重新派发报告更正');
  }
  return task;
}

function synchronizeRequiredSubjects(
  db: Db,
  draft: ReviewDraftRow,
  execution: ReviewExecutionRow,
) {
  const header = db.prepare(`
    SELECT mode, baseline_review_document_id, baseline_review_revision
    FROM review_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    mode: ReviewMode;
    baseline_review_document_id: string | null;
    baseline_review_revision: number | null;
  };
  const task = assertExecutionStillCurrent(db, draft, execution, header);
  if (header.mode === 'report_correction') {
    if (!task.review_document_id || task.review_revision < 1) {
      throw new Error('报告更正缺少当前结卡报告基线');
    }
    db.prepare(`
      UPDATE review_drafts
      SET baseline_review_document_id = ?,
          baseline_review_revision = ?
      WHERE draft_id = ?
    `).run(
      task.review_document_id,
      task.review_revision,
      draft.draft_id,
    );
    cloneLatestReportSections(db, draft, task.review_document_id);
  }
  const desired = header.mode === 'closure'
    ? closureSubjects(db, draft)
    : reportCorrectionSubjects(db, draft, execution);
  const visibleRefs = new Set(visibleResources(execution).map((item) => item.ref));
  const missingContracts = desired
    .map((item) => item.contract_ref)
    .filter((ref): ref is string => Boolean(ref) && !visibleRefs.has(ref!));
  if (missingContracts.length) {
    throw new Error(
      `必需交付契约不在当前冻结 Context Snapshot 中：${missingContracts.join(', ')}。请重新派发`,
    );
  }
  const desiredRefs = new Set(desired.map((item) => item.subject_ref));
  const existing = db.prepare(`
    SELECT subject_ref, contract_ref, subject_hash
    FROM review_required_subjects WHERE draft_id = ?
  `).all(draft.draft_id) as {
    subject_ref: string;
    contract_ref: string | null;
    subject_hash: string;
  }[];
  const existingByRef = new Map(existing.map((item) => [item.subject_ref, item]));

  db.transaction(() => {
    for (const subject of desired) {
      const previous = existingByRef.get(subject.subject_ref);
      const subjectHash = subjectFingerprint(subject);
      if (previous && previous.subject_hash !== subjectHash) {
        db.prepare(`
          DELETE FROM review_reconciliations
          WHERE draft_id = ? AND subject_ref = ?
        `).run(draft.draft_id, subject.subject_ref);
        db.prepare(`
          DELETE FROM review_gaps
          WHERE draft_id = ? AND subject_ref = ?
        `).run(draft.draft_id, subject.subject_ref);
      }
      db.prepare(`
        INSERT INTO review_required_subjects(
          draft_id, subject_ref, subject_kind, content, source_ref,
          contract_ref, story_index, subject_hash, ordinal
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, subject_ref) DO UPDATE SET
          subject_kind = excluded.subject_kind,
          content = excluded.content,
          source_ref = excluded.source_ref,
          contract_ref = excluded.contract_ref,
          story_index = excluded.story_index,
          subject_hash = excluded.subject_hash,
          ordinal = excluded.ordinal
      `).run(
        draft.draft_id,
        subject.subject_ref,
        subject.subject_kind,
        subject.content,
        subject.source_ref,
        subject.contract_ref,
        subject.story_index,
        subjectHash,
        subject.ordinal,
      );
    }
    for (const previous of existing) {
      if (!desiredRefs.has(previous.subject_ref)) {
        db.prepare(`
          DELETE FROM review_required_subjects
          WHERE draft_id = ? AND subject_ref = ?
        `).run(draft.draft_id, previous.subject_ref);
      }
    }
  })();
}

function state(db: Db, draft: ReviewDraftRow) {
  const header = db.prepare(`
    SELECT mode, baseline_review_document_id, baseline_review_revision
    FROM review_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    mode: ReviewMode;
    baseline_review_document_id: string | null;
    baseline_review_revision: number | null;
  };
  const subjects = db.prepare(`
    SELECT subject_ref, subject_kind, content, source_ref, contract_ref,
           story_index, subject_hash, ordinal
    FROM review_required_subjects
    WHERE draft_id = ?
    ORDER BY ordinal, subject_ref
  `).all(draft.draft_id) as RequiredSubject[];
  const rawReconciliations = db.prepare(`
    SELECT reconciliation_key, subject_ref, result, ordinal
    FROM review_reconciliations
    WHERE draft_id = ?
    ORDER BY ordinal, reconciliation_key
  `).all(draft.draft_id) as Omit<Reconciliation, 'evidence'>[];
  const evidence = db.prepare(`
    SELECT reconciliation_key, evidence_ref, evidence_revision, evidence_hash
    FROM review_reconciliation_evidence
    WHERE draft_id = ?
    ORDER BY ordinal, evidence_ref
  `).all(draft.draft_id) as {
    reconciliation_key: string;
    evidence_ref: string;
    evidence_revision: number | null;
    evidence_hash: string;
  }[];
  const reconciliations: Reconciliation[] = rawReconciliations.map((item) => ({
    ...item,
    evidence: evidence
      .filter((entry) => entry.reconciliation_key === item.reconciliation_key)
      .map((entry) => ({
        ref: entry.evidence_ref,
        revision: entry.evidence_revision,
        hash: entry.evidence_hash,
      })),
  }));
  const gaps = db.prepare(`
    SELECT gap_key, subject_ref, gap_kind, reason, boundary, status,
           resolution, forwarded_story_index, ordinal
    FROM review_gaps
    WHERE draft_id = ?
    ORDER BY ordinal, gap_key
  `).all(draft.draft_id) as Gap[];
  const sections = db.prepare(`
    SELECT section_kind, content
    FROM review_sections WHERE draft_id = ?
    ORDER BY CASE section_kind
      WHEN 'outcome' THEN 1 WHEN 'scope' THEN 2 WHEN 'decisions' THEN 3
      WHEN 'implementation' THEN 4 WHEN 'verification' THEN 5
      WHEN 'deviations' THEN 6 WHEN 'risks' THEN 7 WHEN 'feedback' THEN 8
      ELSE 9 END
  `).all(draft.draft_id) as {
    section_kind: SectionKind;
    content: string;
  }[];
  return { header, subjects, reconciliations, gaps, sections };
}

type ReviewState = ReturnType<typeof state>;

function validationErrors(
  current: ReviewState,
  resources: ContextResource[],
  terminal = false,
) {
  const errors: string[] = [];
  const activeGaps = current.gaps.filter((item) => item.status === 'active');
  const visibleByRef = new Map(resources.map((item) => [item.ref, item]));
  for (const subject of current.subjects) {
    const reconciliation = current.reconciliations.find((item) =>
      item.subject_ref === subject.subject_ref);
    const gap = activeGaps.find((item) => item.subject_ref === subject.subject_ref);
    if (!reconciliation && !gap) {
      errors.push(`尚未对账：${subject.subject_ref}`);
    }
    if (reconciliation && gap) {
      errors.push(`同一对象不能同时已对账和存在活动缺口：${subject.subject_ref}`);
    }
    if (reconciliation) {
      const validEvidence = reconciliation.evidence.flatMap((entry) => {
        const resource = visibleByRef.get(entry.ref);
        if (!resource) {
          errors.push(
            `对账 ${reconciliation.reconciliation_key} 的证据已不在当前冻结 Context Snapshot：${entry.ref}`,
          );
          return [];
        }
        if (
          (resource.revision ?? null) !== entry.revision
          || resourceFingerprint(resource) !== entry.hash
        ) {
          errors.push(
            `对账 ${reconciliation.reconciliation_key} 的证据版本或内容已变化：${entry.ref}`,
          );
          return [];
        }
        return [resource];
      });
      const independentTestEvidence = validEvidence.some(isIndependentTestEvidence);
      if (current.header.mode === 'closure' && !independentTestEvidence) {
        errors.push(`对账 ${reconciliation.reconciliation_key} 缺少独立 Test 证据`);
      }
    }
  }
  if (!current.subjects.length) errors.push('没有可对账的最终事实对象');
  if (terminal && current.header.mode === 'report_correction' && activeGaps.length) {
    errors.push('报告表达更正不能声明结卡缺口；该反馈必须重新分流');
  }
  if (terminal && !activeGaps.length) {
    const sectionKinds = new Set(current.sections.map((item) => item.section_kind));
    const missing = REQUIRED_REPORT_SECTIONS.filter((kind) => !sectionKinds.has(kind));
    if (missing.length) {
      errors.push(`缺少结卡报告核心章节：${missing.join(', ')}`);
    }
  }
  return [...new Set(errors)];
}

function renderStatus(draft: ReviewDraftRow, current: ReviewState, resources: ContextResource[]) {
  const activeGaps = current.gaps.filter((item) => item.status === 'active');
  const lines = [
    `最终事实对账草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    `模式：${current.header.mode === 'closure' ? '普通结卡' : '报告表达更正'}`,
    current.header.baseline_review_revision
      ? `报告基线：revision ${current.header.baseline_review_revision}`
      : '报告基线：无',
    '',
    `必需对账对象：${current.subjects.length}`,
    `已对账：${current.reconciliations.length}`,
    `活动缺口：${activeGaps.length}`,
    `报告章节：${current.sections.length}/${SECTION_KINDS.length}`,
    '',
    '必需对账对象（--subject 必须逐字使用以下 ref）：',
  ];
  for (const subject of current.subjects) {
    const reconciliation = current.reconciliations.find((item) =>
      item.subject_ref === subject.subject_ref);
    const gap = activeGaps.find((item) => item.subject_ref === subject.subject_ref);
    const stateLabel = reconciliation
      ? `已对账=${reconciliation.reconciliation_key}`
      : gap
        ? `缺口=${gap.gap_key}`
        : '待处理';
    lines.push(
      `- ${subject.subject_ref} · ${subject.subject_kind} · ${stateLabel}`,
      `  ${subject.content.replace(/\n/g, '\n  ')}`,
      ...(subject.contract_ref ? [`  contract=${subject.contract_ref}`] : []),
    );
  }
  if (current.reconciliations.length) {
    lines.push('', '已保存对账（key 跨轮次保持稳定）：');
    for (const item of current.reconciliations) {
      lines.push(
        `- ${item.reconciliation_key} · ${item.subject_ref}`,
        `  结果：${item.result.replace(/\n/g, '\n  ')}`,
        `  证据：${item.evidence.map((entry) => entry.ref).join(', ')}`,
      );
    }
  }
  if (current.gaps.length) {
    lines.push('', '结卡缺口：');
    for (const item of current.gaps) {
      lines.push(
        `- ${item.gap_key} · ${item.gap_kind} · ${item.status} · ${item.subject_ref}`,
        `  原因：${item.reason.replace(/\n/g, '\n  ')}`,
        `  边界：${item.boundary.replace(/\n/g, '\n  ')}`,
        ...(item.resolution ? [`  解决：${item.resolution}`] : []),
        ...(item.forwarded_story_index
          ? [`  已前向追加交付单元 ${item.forwarded_story_index}`]
          : []),
      );
    }
  }
  lines.push('', '报告章节（只写有事实内容的章节）：');
  for (const kind of SECTION_KINDS) {
    const section = current.sections.find((item) => item.section_kind === kind);
    lines.push(`- ${kind} · ${DEFAULT_HEADINGS[kind]}：${section ? '已填写' : '未填写'}`);
    if (section) lines.push(`  ${section.content.replace(/\n/g, '\n  ')}`);
  }
  const errors = validationErrors(current, resources);
  if (errors.length) {
    lines.push('', '当前待完成：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else if (activeGaps.length) {
    lines.push('', '全部对象已有结论；complete 将提交 closure_gap，由 Application 前向追加补齐工作。');
  } else {
    lines.push('', '全部对象已有独立证据支持的最终结论；补齐核心报告章节后可以 complete。');
  }
  return lines.join('\n');
}

function renderArtifact(db: Db, draft: ReviewDraftRow, current: ReviewState) {
  const task = taskHeader(db, draft.task_id);
  const lines = [
    `# ${task.title} · 结卡报告`,
  ];
  for (const section of current.sections) {
    lines.push('', `## ${DEFAULT_HEADINGS[section.section_kind]}`, '', section.content);
  }
  lines.push('', '## 最终事实对账', '');
  for (const subject of current.subjects) {
    const reconciliation = current.reconciliations.find((item) =>
      item.subject_ref === subject.subject_ref);
    if (!reconciliation) continue;
    lines.push(
      `### ${subject.subject_ref}`,
      '',
      reconciliation.result,
      '',
      `证据：${reconciliation.evidence.map((entry) => `\`${entry.ref}\``).join('、')}`,
      '',
    );
  }
  return lines.join('\n').trim();
}

function terminalSubmit(
  db: Db,
  draft: ReviewDraftRow,
  execution: ReviewExecutionRow,
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  assertExecutionStillCurrent(db, draft, execution, current.header);
  const resources = visibleResources(execution);
  const errors = validationErrors(current, resources, true);
  if (errors.length) {
    throw new Error(`最终事实对账不能完成：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const activeGaps = current.gaps.filter((item) => item.status === 'active');
  const outcomeSection = current.sections.find((item) =>
    item.section_kind === 'outcome')?.content;
  const result = activeGaps.length
    ? agentResultSchema.parse({
        outcome: 'completed',
        summary: `发现 ${activeGaps.length} 个结卡缺口，需要前向追加交付单元后重新结卡。`,
        verdict: 'closure_gap',
        closureGaps: activeGaps.map((item) => ({
          key: item.gap_key,
          subject: item.subject_ref,
          kind: item.gap_kind,
          reason: item.reason,
          boundary: item.boundary,
        })),
      })
    : agentResultSchema.parse({
        outcome: 'completed',
        summary: bounded(outcomeSection || '最终事实对账完成。', '结卡摘要', 4000),
        artifact: {
          title: `${taskHeader(db, draft.task_id).title} · 结卡报告`,
          content: renderArtifact(db, draft, current),
        },
        verdict: 'report_ready',
      });
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = 'submitted', terminal_action = 'complete',
          terminal_execution_id = ?, submitted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, draft.draft_id);
    db.prepare(`
      UPDATE execution_attempts
      SET result_json = ?, status = 'output_received', heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ?
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return activeGaps.length
    ? `已提交 ${activeGaps.length} 个结卡缺口；Application 将前向追加补齐工作。`
    : '最终事实对账与结卡报告已提交。';
}

export function reviewHelp(terminalActions: string[], topic: string | null = null) {
  const reconciliation = [
    '最终事实对账：',
    '  review reconciliation upsert --key <稳定 key> --subject <status 列出的 ref> --result <最终可观察结果> --evidence <context ref[,context ref...]>',
    '    保存一个对象的最终结论。普通结卡的 evidence 至少包含一条 verdict=passed 的独立 Test Agent 执行记录；文档和规格可以作为补充证据。',
    '  review reconciliation dismiss --key <稳定 key>',
    '    删除一条错误的草稿对账；随后仍必须重新对账或为该 subject 声明缺口。',
  ];
  const gaps = [
    '结卡缺口（仅普通结卡）：',
    '  review gap upsert --key <稳定 key> --subject <status 列出的 ref> --kind <missing_evidence|fact_conflict|unresolved_obligation> --reason <为何不能结卡> --boundary <已经确认与尚未确认的边界>',
    '    记录事实链无法闭合的原因，不选择 Agent 或阶段；Application 会把缺口前向追加为新交付单元。',
    '  review gap resolve --key <稳定 key> --reason <为何缺口已消失>',
    '    关闭草稿中的活动缺口；随后必须为对应 subject 保存对账。',
  ];
  const report = [
    '结卡报告：',
    `  review report section-upsert --kind <${SECTION_KINDS.join('|')}> --content <Markdown 正文>`,
    '    渐进保存有事实内容的章节。标题由 Application 生成；至少需要 outcome、scope、implementation、verification、risks。',
  ];
  const finish = [
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
    '    无活动缺口时生成结卡报告；有活动缺口时提交 closure_gap。报告表达更正只允许生成候选新报告。',
  ];
  if (topic === 'reconciliation') return reconciliation;
  if (topic === 'gap') return gaps;
  if (topic === 'report') return report;
  if (topic === 'finish') return finish;
  if (topic) {
    throw new Error(`结卡报告 help 不支持主题：${topic}。可用主题：context、reconciliation、gap、report、finish`);
  }
  return [
    '结卡报告 Agent 只消费已经存在的需求、交付与独立验证事实；它不重新测试、不修改代码，也不创建人工问题。',
    '',
    '恢复与查看：',
    '  review status',
    '    冻结并列出本轮必须逐项对账的 subject ref、已有结果、缺口和完整报告草稿。每次启动必须先执行。',
    '',
    ...reconciliation,
    '',
    ...gaps,
    '',
    ...report,
    '',
    ...finish,
    '',
    '主题帮助：',
    '  help context         冻结上下文读取工具',
    '  help reconciliation  对账对象、最终结果与证据',
    '  help gap             缺口分类与前向处理',
    '  help report          报告章节',
    '  help finish          完成条件与两种结果',
  ];
}

export function runReviewCommand(input: {
  db: Db;
  execution: ReviewExecutionRow;
  draft: ReviewDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, draft, command, flags } = input;
  if (command === 'review status') {
    // A draft version freezes its subjects on first inspection. A version
    // cloned after a terminal result starts unviewed, so it refreshes newly
    // appended units/spec revisions once; repeated status calls in the same
    // work cycle cannot drift with concurrent database changes.
    if (!draft.status_viewed_execution_id) {
      synchronizeRequiredSubjects(db, draft, execution);
    }
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    return renderStatus(
      { ...draft, status_viewed_execution_id: execution.execution_id },
      state(db, draft),
      visibleResources(execution),
    );
  }
  if (
    command === 'review complete'
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === 'complete'
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);

  if (command === 'review reconciliation upsert') {
    const key = bounded(required(flags, 'key'), '对账 key', 120);
    const subject = bounded(required(flags, 'subject'), '对账对象', 500);
    if (!current.subjects.some((item) => item.subject_ref === subject)) {
      throw new Error(`--subject 不在本轮必需对账对象中：${subject}。请重新执行 review status`);
    }
    const existing = current.reconciliations.find((item) =>
      item.reconciliation_key === key);
    if (existing && existing.subject_ref !== subject) {
      throw new Error(
        `稳定 key ${key} 已绑定 ${existing.subject_ref}，不能改绑到 ${subject}；请为新对象使用新 key`,
      );
    }
    const activeGap = current.gaps.find((item) =>
      item.subject_ref === subject && item.status === 'active');
    if (activeGap) {
      throw new Error(`对象仍有活动缺口 ${activeGap.gap_key}；请先 review gap resolve`);
    }
    const existingForSubject = current.reconciliations.find((item) =>
      item.subject_ref === subject && item.reconciliation_key !== key);
    if (existingForSubject) {
      throw new Error(`该对象已使用稳定 key ${existingForSubject.reconciliation_key}；请复用原 key`);
    }
    const refs = parseEvidenceRefs(flags);
    const resources = new Map(visibleResources(execution).map((item) => [item.ref, item]));
    const unknown = refs.filter((ref) => !resources.has(ref));
    if (unknown.length) {
      throw new Error(`证据引用不在当前冻结 Context Snapshot 中：${unknown.join(', ')}`);
    }
    if (current.header.mode === 'closure'
      && !refs.some((ref) => isIndependentTestEvidence(resources.get(ref)!))) {
      throw new Error('普通结卡对账至少需要一条独立 Test Agent 的验证证据');
    }
    const ordinal = existing?.ordinal
      || nextOrdinal(db, 'review_reconciliations', draft.draft_id);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO review_reconciliations(
          draft_id, reconciliation_key, subject_ref, result, ordinal
        ) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, reconciliation_key) DO UPDATE SET
          subject_ref = excluded.subject_ref,
          result = excluded.result
      `).run(
        draft.draft_id,
        key,
        subject,
        bounded(required(flags, 'result'), '最终结果', 10000),
        ordinal,
      );
      db.prepare(`
        DELETE FROM review_reconciliation_evidence
        WHERE draft_id = ? AND reconciliation_key = ?
      `).run(draft.draft_id, key);
      refs.forEach((ref, index) => {
        const resource = resources.get(ref)!;
        db.prepare(`
          INSERT INTO review_reconciliation_evidence(
            draft_id, reconciliation_key, evidence_ref,
            evidence_revision, evidence_hash, ordinal
          ) VALUES(?, ?, ?, ?, ?, ?)
        `).run(
          draft.draft_id,
          key,
          ref,
          resource.revision ?? null,
          resourceFingerprint(resource),
          index + 1,
        );
      });
      touchDraft(db, draft.draft_id);
    })();
    return `最终事实对账 ${key} 已保存。`;
  }

  if (command === 'review reconciliation dismiss') {
    const key = required(flags, 'key');
    const existing = current.reconciliations.find((item) =>
      item.reconciliation_key === key);
    if (!existing) throw new Error(`对账 ${key} 不存在`);
    db.prepare(`
      DELETE FROM review_reconciliations
      WHERE draft_id = ? AND reconciliation_key = ?
    `).run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `最终事实对账 ${key} 已移除。`;
  }

  if (command === 'review gap upsert') {
    if (current.header.mode === 'report_correction') {
      throw new Error('报告表达更正不能创建结卡缺口；请由 Feedback Agent 重新分流');
    }
    const key = bounded(required(flags, 'key'), '缺口 key', 120);
    const subject = bounded(required(flags, 'subject'), '缺口对象', 500);
    if (!current.subjects.some((item) => item.subject_ref === subject)) {
      throw new Error(`--subject 不在本轮必需对账对象中：${subject}。请重新执行 review status`);
    }
    const existing = current.gaps.find((item) => item.gap_key === key);
    if (existing && existing.subject_ref !== subject) {
      throw new Error(
        `稳定 key ${key} 已绑定 ${existing.subject_ref}，不能改绑到 ${subject}；请为新对象使用新 key`,
      );
    }
    if (existing?.status === 'forwarded') {
      throw new Error(`缺口 ${key} 已形成前向交付单元，不能重新激活或改写`);
    }
    const reconciliation = current.reconciliations.find((item) =>
      item.subject_ref === subject);
    if (reconciliation) {
      throw new Error(`对象已有对账 ${reconciliation.reconciliation_key}；请先 reconciliation dismiss`);
    }
    const otherActive = current.gaps.find((item) =>
      item.subject_ref === subject && item.status === 'active' && item.gap_key !== key);
    if (otherActive) {
      throw new Error(`对象已有活动缺口 ${otherActive.gap_key}；请复用原 key`);
    }
    const ordinal = existing?.ordinal || nextOrdinal(db, 'review_gaps', draft.draft_id);
    db.prepare(`
      INSERT INTO review_gaps(
        draft_id, gap_key, subject_ref, gap_kind, reason, boundary,
        status, resolution, forwarded_story_index, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)
      ON CONFLICT(draft_id, gap_key) DO UPDATE SET
        subject_ref = excluded.subject_ref,
        gap_kind = excluded.gap_kind,
        reason = excluded.reason,
        boundary = excluded.boundary,
        status = 'active',
        resolution = NULL,
        forwarded_story_index = NULL
    `).run(
      draft.draft_id,
      key,
      subject,
      gapKind(flags),
      bounded(required(flags, 'reason'), '缺口原因', 4000),
      bounded(required(flags, 'boundary'), '事实边界', 4000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `结卡缺口 ${key} 已保存。`;
  }

  if (command === 'review gap resolve') {
    const key = required(flags, 'key');
    const existing = current.gaps.find((item) =>
      item.gap_key === key && item.status === 'active');
    if (!existing) throw new Error(`活动缺口 ${key} 不存在`);
    db.prepare(`
      UPDATE review_gaps
      SET status = 'resolved', resolution = ?
      WHERE draft_id = ? AND gap_key = ?
    `).run(
      bounded(required(flags, 'reason'), '解决原因', 4000),
      draft.draft_id,
      key,
    );
    touchDraft(db, draft.draft_id);
    return `结卡缺口 ${key} 已解决；请为对应对象保存最终对账。`;
  }

  if (command === 'review report section-upsert') {
    const kind = sectionKind(flags);
    db.prepare(`
      INSERT INTO review_sections(draft_id, section_kind, content)
      VALUES(?, ?, ?)
      ON CONFLICT(draft_id, section_kind) DO UPDATE SET
        content = excluded.content
    `).run(
      draft.draft_id,
      kind,
      bounded(required(flags, 'content'), '章节正文', 30000),
    );
    touchDraft(db, draft.draft_id);
    return `结卡报告章节 ${kind} 已保存。`;
  }

  if (command === 'review complete') {
    return terminalSubmit(db, draft, execution);
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
