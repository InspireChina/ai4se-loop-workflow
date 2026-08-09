import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { agentResultSchema } from '../domain/agent-result';
import {
  businessAnalysisWorkflow,
  type BusinessAnalysisAgentId,
} from '../domain/business-analysis-workflow';
import { workflowDecisionMode } from '../domain/requirement-metadata';
import { recomputeTaskQuestionApplicabilityInDb } from './tasks';

type Db = Database.Database;

type Execution = {
  execution_id: string;
  task_id: string;
  agent: string;
  pipeline: string;
};

type Draft = {
  draft_id: string;
  task_id: string;
  agent: string;
  status: string;
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

type Input = {
  db: Db;
  execution: Execution;
  draft: Draft;
  command: string;
  flags: Map<string, string>;
};

const optionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(240),
  consequences: z.array(z.string().min(1).max(1000)).min(1).max(20),
});

const proposalSchema = z.object({
  summary: z.string().min(1).max(10000),
  questions: z.array(z.object({
    key: z.string().min(1).max(240),
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(4000),
    impact: z.string().min(1).max(1000),
    options: z.array(optionSchema).min(2).max(20),
    recommendationOption: z.string().min(1).max(100),
    recommendationReason: z.string().min(1).max(2000),
    proposedAuthority: z.enum(['human', 'agent']).optional().default('human'),
    activation: z.array(z.object({
      decisionKey: z.string().min(1).max(240),
      optionId: z.string().min(1).max(100),
    })).max(50).optional().default([]),
  })).max(100),
}).superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, question] of value.questions.entries()) {
    if (keys.has(question.key)) context.addIssue({ code: 'custom', path: ['questions', index, 'key'], message: 'decision key 不能重复' });
    keys.add(question.key);
    const optionIds = new Set(question.options.map((option) => option.id));
    if (!optionIds.has(question.recommendationOption)) {
      context.addIssue({ code: 'custom', path: ['questions', index, 'recommendationOption'], message: '推荐选项不存在' });
    }
  }
});

const resolutionSchema = z.object({
  notes: z.string().min(1).max(10000),
  agentDecisions: z.array(z.object({
    key: z.string().min(1).max(240),
    optionId: z.string().min(1).max(100),
    reason: z.string().min(1).max(4000),
  })).max(100).default([]),
  humanDecisionKeys: z.array(z.string().min(1).max(240)).max(100).default([]),
});

const reviewClassificationSchema = z.object({
  summary: z.string().min(1).max(10000),
  gaps: z.array(z.object({
    key: z.string().min(1).max(240),
    target: z.enum(['intent', 'business_design', 'specification']),
    affectedSections: z.array(z.string().min(1).max(200)).min(1).max(30),
    evidence: z.string().min(1).max(4000),
    reason: z.string().min(1).max(4000),
  })).max(100),
});

function required(flags: Map<string, string>, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function bounded(value: string, label: string, max = 100_000) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return normalized;
}

function parseJson<S extends z.ZodTypeAny>(schema: S, content: string, label: string): z.output<S> {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`${label}必须是有效 JSON；长内容请使用 --artifact-file`); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${label}格式错误：${result.error.issues.map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`).join('；')}`);
  return result.data as z.output<S>;
}

function workflowFor(execution: Execution) {
  const workflow = businessAnalysisWorkflow(execution.agent);
  if (!workflow) throw new Error(`未知 Business Analysis Agent：${execution.agent}`);
  return workflow;
}

function state(db: Db, draftId: string) {
  const draft = db.prepare(`
    SELECT workflow_phase, validated_change_seq
    FROM business_analysis_drafts WHERE draft_id = ?
  `).get(draftId) as { workflow_phase: string; validated_change_seq: number | null } | undefined;
  if (!draft) throw new Error('Business Analysis 草稿不存在');
  const artifacts = db.prepare(`
    SELECT phase, content, updated_at
    FROM business_analysis_phase_artifacts
    WHERE draft_id = ? ORDER BY updated_at, phase
  `).all(draftId) as { phase: string; content: string; updated_at: string }[];
  return { draft, artifacts };
}

function artifactFor(db: Db, draftId: string, phase: string) {
  return (db.prepare(`
    SELECT content FROM business_analysis_phase_artifacts
    WHERE draft_id = ? AND phase = ?
  `).get(draftId, phase) as { content: string } | undefined)?.content || null;
}

function saveArtifact(db: Db, draftId: string, phase: string, content: string) {
  db.prepare(`
    INSERT INTO business_analysis_phase_artifacts(draft_id, phase, content)
    VALUES(?, ?, ?)
    ON CONFLICT(draft_id, phase) DO UPDATE SET
      content = excluded.content,
      updated_at = CURRENT_TIMESTAMP
  `).run(draftId, phase, content);
  db.prepare(`
    UPDATE agent_work_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function commandResult(command: string, outcome: string, details: string[] = []) {
  return [
    '# COMMAND RESULT', '',
    `- Command: \`${command}\``,
    `- Outcome: ${outcome}`,
    ...details.map((detail) => `- ${detail}`),
  ].join('\n');
}

function decisionMode(db: Db, taskId: string) {
  const metadata = db.prepare(`
    SELECT metadata_key, metadata_value
    FROM requirement_metadata WHERE task_id = ?
  `).all(taskId) as { metadata_key: string; metadata_value: string }[];
  return workflowDecisionMode(metadata);
}

function answerPhaseDecisionPolicy(agent: string, mode: ReturnType<typeof decisionMode>) {
  if (agent === 'idea-context-agent') {
    return {
      conservative: '审慎对齐：只自行关闭由权威输入唯一确定的事实性解释，其余目标、参与者、成功结果和约束歧义进入 HUMAN 批次。',
      balanced: '平衡：可自行关闭不改变需求含义的术语归一和等价表述；会改变目标、参与者、成功结果或硬约束的节点进入 HUMAN 批次。',
      autonomous: '高度自主：可根据原始想法、权威资料和明确推荐关闭低风险意图解释；核心目标、目标参与者、成功标准或不可逆约束变化仍进入 HUMAN 批次。',
      fully_autonomous: '完全自主：继承明确用户决定后，自行关闭全部活动需求意图节点，不得形成 HUMAN 决策批次。',
    }[mode];
  }
  return {
    conservative: '审慎对齐：只自行关闭由权威输入唯一确定的节点，其余业务取舍进入 HUMAN 批次。',
    balanced: '平衡：可自行关闭低风险、可逆且不改变核心用户结果的节点；重要业务结果分叉进入 HUMAN 批次。',
    autonomous: '高度自主：可在已确认需求意图内自行关闭有明确推荐和充分依据的业务取舍；目标、参与者、成功标准或不可逆高风险变化仍进入 HUMAN 批次。',
    fully_autonomous: '完全自主：继承明确用户决定后，自行关闭全部活动业务节点，不得形成 HUMAN 决策批次。',
  }[mode];
}

function workPacket(db: Db, execution: Execution, draft: Draft) {
  const workflow = workflowFor(execution);
  const current = state(db, draft.draft_id);
  const definition = workflow.definitions[current.draft.workflow_phase];
  if (!definition) throw new Error(`草稿阶段 ${current.draft.workflow_phase} 不受 ${execution.agent} 支持`);
  const isAnswerPhase = (execution.agent === 'idea-context-agent' && current.draft.workflow_phase === 'clarification_resolution')
    || (execution.agent === 'business-design-agent' && current.draft.workflow_phase === 'decision_resolution');
  const mode = isAnswerPhase
    ? decisionMode(db, execution.task_id)
    : null;
  const decisionPolicy = mode ? answerPhaseDecisionPolicy(execution.agent, mode) : null;
  const lines = [
    '# NEXT WORK PACKET', '',
    `- Phase: ${definition.label}`,
    `- Objective: ${definition.objective}`,
    ...(mode ? [`- Decision Mode: ${mode}`] : []),
    ...(decisionPolicy ? [`- Decision Policy: ${decisionPolicy}`, `- Policy Scope: 仅在当前 ${definition.label} 工作包生效。`] : []),
    '', '# REQUIRED OUTPUT', '',
    ...definition.required.map((item) => `- ${item}`),
    '', '# PROHIBITED', '',
    ...definition.prohibited.map((item) => `- ${item}`),
  ];
  if (definition.submit) {
    const needsArtifact = definition.submit === `${workflow.namespace} complete`
      ? ''
      : ' --artifact-file <工作包文件>';
    lines.push('', '# SUBMIT', '', `\`${definition.submit}${needsArtifact}\``);
    if (isAnswerPhase) {
      const phaseCommand = execution.agent === 'idea-context-agent' ? 'clarification-resolution' : 'decision-resolution';
      lines.push(
        '',
        '# AFTER RESOLUTION',
        '',
        '读取本轮全部 HUMAN 与 Agent 答案，继续分析它们的组合后果，以及是否引入当前问题树无法表达的新语义。任何决策主体和决策强度都不得跳过审查，只能选择一个出口：',
        '',
        `- 无新增分支：\`${workflow.namespace} ${phaseCommand} audit-complete --artifact-file <答案审查>\``,
        `- 需要增量补问：\`${workflow.namespace} ${phaseCommand} expand --artifact-file <答案审查与新增分支依据>\``,
      );
    }
  } else {
    lines.push('', '# SUBMIT', '', '`spec-review approve --artifact-file <完整需求规格>` 或 `spec-review return-revision --target <intent|business_design|specification> --reason-file <理由>`');
  }
  if (current.artifacts.length) {
    lines.push('', '# SAVED WORK', '');
    for (const artifact of current.artifacts) lines.push(`- ${artifact.phase}: ${artifact.content.length} chars`);
  }
  return lines.join('\n');
}

function assertViewed(draft: Draft, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次 execution 尚未执行 status；所有编辑和终止命令均被拒绝');
  }
}

function transition(input: Input, from: string, to: string, content: string, reason: string) {
  const { db, draft, execution, command } = input;
  db.transaction(() => {
    saveArtifact(db, draft.draft_id, from, content);
    db.prepare(`
      UPDATE business_analysis_drafts
      SET workflow_phase = ?, validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(to, draft.draft_id);
    db.prepare(`
      INSERT INTO business_analysis_phase_transitions(
        draft_id, from_phase, to_phase, reason, execution_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, reason, execution.execution_id);
  })();
  return [commandResult(command, 'phase_completed', [`From: ${from}`, `To: ${to}`]), '', workPacket(db, execution, draft)].join('\n');
}

function proposalFor(db: Db, draftId: string, phase: 'clarification_proposal' | 'decision_proposal') {
  const content = artifactFor(db, draftId, phase);
  if (!content) throw new Error(`${phase} 尚未保存问题树`);
  return parseJson(proposalSchema, content, '问题树');
}

function validateProposalRound(
  db: Db,
  execution: Execution,
  proposal: z.infer<typeof proposalSchema>,
) {
  const priorRows = db.prepare(`
    SELECT decision_key, alternatives_json
    FROM questions
    WHERE task_id = ? AND story_index IS NULL AND source_agent = ?
      AND decision_key IS NOT NULL
  `).all(execution.task_id, execution.agent) as { decision_key: string; alternatives_json: string | null }[];
  const prior = new Map(priorRows.map((row) => [row.decision_key, row]));
  const repeated = proposal.questions.filter((question) => prior.has(question.key));
  if (repeated.length) {
    throw new Error(`增量问题不得重问或改名覆盖已有节点：${repeated.map((question) => question.key).join('、')}`);
  }
  const current = new Map(proposal.questions.map((question) => [question.key, question.options]));
  for (const question of proposal.questions) {
    for (const gate of question.activation) {
      const options = current.get(gate.decisionKey)
        || parseJson(z.array(optionSchema), prior.get(gate.decisionKey)?.alternatives_json || '[]', `父决策 ${gate.decisionKey} 的选项`);
      if (!options.some((option) => option.id === gate.optionId)) {
        throw new Error(`问题 ${question.key} 的激活条件引用了未知父节点或选项：${gate.decisionKey}=${gate.optionId}`);
      }
    }
  }
}

function assertAnswerAuditReady(
  db: Db,
  execution: Execution,
  draftId: string,
  phase: 'clarification_resolution' | 'decision_resolution',
) {
  const intentResolution = phase === 'clarification_resolution';
  const proposal = proposalFor(db, draftId, intentResolution ? 'clarification_proposal' : 'decision_proposal');
  const resolution = parseJson(
    resolutionSchema,
    artifactFor(db, draftId, phase) || '',
    intentResolution ? '需求意图回答工作包' : '决策解决工作包',
  );
  recomputeTaskQuestionApplicabilityInDb(db, execution.task_id, execution.agent, null);
  const rows = new Map(questionRows(db, execution.task_id, execution.agent).map((row) => [row.decision_key, row]));
  const unresolvedHuman = resolution.humanDecisionKeys.filter((key) => {
    const row = rows.get(key);
    return !row || !['answered', 'resolved', 'not_applicable', 'superseded'].includes(row.status);
  });
  if (unresolvedHuman.length) throw new Error(`仍在等待用户回答：${unresolvedHuman.join('、')}`);
  const unresolved = proposal.questions.filter((question) => {
    const row = rows.get(question.key);
    return !row || !['answered', 'resolved', 'not_applicable', 'superseded'].includes(row.status);
  });
  if (unresolved.length) throw new Error(`当前问题轮次仍有未关闭节点：${unresolved.map((question) => question.key).join('、')}`);
}

function questionRows(db: Db, taskId: string, sourceAgent: string) {
  return db.prepare(`
    SELECT decision_key, status, answer, selected_option_id, decision_authority
    FROM questions
    WHERE task_id = ? AND story_index IS NULL AND source_agent = ?
      AND decision_key IS NOT NULL
    ORDER BY created_at, question_id
  `).all(taskId, sourceAgent) as {
    decision_key: string;
    status: string;
    answer: string | null;
    selected_option_id: string | null;
    decision_authority: string;
  }[];
}

function proposalQuestionsForResult(
  db: Db,
  execution: Execution,
  proposal: z.infer<typeof proposalSchema>,
  requestedKeys: string[],
) {
  const existing = new Set(questionRows(db, execution.task_id, execution.agent).map((row) => row.decision_key));
  return proposal.questions
    .filter((question) => requestedKeys.includes(question.key) && !existing.has(question.key))
    .map((question) => ({
      decisionKey: question.key,
      title: question.title,
      question: question.question,
      why: question.impact,
      recommendation: question.options.find((option) => option.id === question.recommendationOption)?.label || '',
      recommendationReason: question.recommendationReason,
      alternatives: question.options,
      activation: question.activation,
      initialStatus: question.activation.length ? 'conditional' as const : 'pending' as const,
    }));
}

function publishAgentDecision(
  db: Db,
  execution: Execution,
  proposal: z.infer<typeof proposalSchema>,
  decision: z.infer<typeof resolutionSchema>['agentDecisions'][number],
) {
  const question = proposal.questions.find((candidate) => candidate.key === decision.key);
  if (!question) throw new Error(`Agent 决定引用未知 key：${decision.key}`);
  const option = question.options.find((candidate) => candidate.id === decision.optionId);
  if (!option) throw new Error(`Agent 决定 ${decision.key} 引用了未知选项 ${decision.optionId}`);
  const existing = db.prepare(`
    SELECT question_id FROM questions
    WHERE task_id = ? AND story_index IS NULL AND source_agent = ? AND decision_key = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(execution.task_id, execution.agent, decision.key) as { question_id: string } | undefined;
  const alternatives = JSON.stringify(question.options);
  const activation = question.activation.length ? JSON.stringify(question.activation) : null;
  if (existing) {
    db.prepare(`
      UPDATE questions SET title = ?, question = ?, why = ?, recommendation = ?, answer = ?,
        status = 'answered', selected_option_id = ?, alternatives_json = ?,
        recommendation_reason = ?, activation_json = ?, decision_authority = 'agent',
        status_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE question_id = ?
    `).run(
      question.title, question.question, question.impact, option.label, option.label,
      option.id, alternatives, decision.reason, activation, existing.question_id,
    );
  } else {
    db.prepare(`
      INSERT INTO questions(
        question_id, task_id, story_index, kind, title, question, why, recommendation,
        answer, status, relative_path, source_agent, decision_key, alternatives_json,
        recommendation_reason, activation_json, selected_option_id, decision_authority
      ) VALUES(?, ?, NULL, 'local', ?, ?, ?, ?, ?, 'answered', NULL, ?, ?, ?, ?, ?, ?, 'agent')
    `).run(
      `Q-${randomUUID().slice(0, 8)}`, execution.task_id, question.title, question.question,
      question.impact, option.label, option.label, execution.agent, question.key,
      alternatives, decision.reason, activation, option.id,
    );
  }
}

function terminal(
  input: Input,
  action: string,
  resultInput: Parameters<typeof agentResultSchema.parse>[0],
  waiting = false,
) {
  const { db, draft, execution, command } = input;
  if (draft.terminal_execution_id === execution.execution_id && draft.terminal_action === action) {
    return [commandResult(command, 'already_submitted'), '', '# NEXT', '', '- Owner: Application', '- Agent Action: end_execution'].join('\n');
  }
  const result = agentResultSchema.parse(resultInput);
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = ?, terminal_action = ?, terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(waiting ? 'waiting_for_answers' : 'submitted', action, execution.execution_id, draft.draft_id);
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return [commandResult(command, waiting ? 'clarification_requested' : 'completed'), '', '# NEXT', '', '- Owner: Application', '- Agent Action: end_execution'].join('\n');
}

function returnRevision(input: Input, stage: 'business_design' | 'specification' | 'review', forcedTarget?: 'intent') {
  const target = forcedTarget || required(input.flags, 'target');
  if (!['intent', 'business_design', 'specification'].includes(target)) throw new Error('--target 必须是 intent、business_design 或 specification');
  if (stage === 'specification' && target === 'specification') throw new Error('需求规格 Agent 的表达问题应在当前草稿修正，不能回流给自己');
  const reason = bounded(required(input.flags, 'reason'), '回流理由', 4000);
  const artifact = input.flags.get('artifact')?.trim();
  return terminal(input, 'return-revision', {
    outcome: 'completed',
    summary: reason,
    ...(artifact ? { artifact: { title: 'Business Analysis 缺口', content: artifact } } : {}),
    businessAnalysis: {
      stage,
      disposition: 'return_revision',
      target,
      reason,
    },
  });
}

export function businessAnalysisHelp(agent: string, topic?: string | null) {
  const workflow = businessAnalysisWorkflow(agent);
  if (!workflow) throw new Error(`未知 Business Analysis Agent：${agent}`);
  if (topic && !['context', 'workflow', 'artifact', 'decision', 'finish'].includes(topic)) {
    throw new Error(`Business Analysis help 不支持主题：${topic}`);
  }
  const commands = workflow.phases
    .map((phase) => workflow.definitions[phase].submit)
    .filter((command): command is string => Boolean(command));
  return [
    `${agent} 使用聚合工作包命令链；一个 --artifact-file 承载当前阶段的完整产物，不逐字段提交。`,
    '',
    `阶段：${workflow.phases.map((phase) => workflow.definitions[phase].label).join(' → ')}`,
    '',
    '命令：',
    `  ${workflow.namespace} status`,
    ...commands.map((command) => `  ${command}${command.endsWith(' complete') && !command.endsWith(`${workflow.namespace} complete`) ? ' --artifact-file <工作包文件>' : ''}`),
    ...(agent === 'idea-context-agent' || agent === 'business-design-agent' ? [`  ${workflow.namespace} request-clarification`] : []),
    ...(agent === 'idea-context-agent' ? [
      '  idea-context clarification-resolution audit-complete --artifact-file <答案审查>',
      '  idea-context clarification-resolution expand --artifact-file <答案审查与新增分支依据>',
    ] : []),
    ...(agent === 'business-design-agent' ? [
      '  business-design decision-resolution audit-complete --artifact-file <答案审查>',
      '  business-design decision-resolution expand --artifact-file <答案审查与新增分支依据>',
    ] : []),
    ...(agent === 'business-design-agent' ? ['  business-design return-gap --reason-file <需求意图缺口> [--artifact-file <缺口报告>]'] : []),
    ...(agent === 'requirement-spec-agent' ? ['  requirement-spec return-gap --target <intent|business_design> --reason-file <理由> [--artifact-file <缺口报告>]'] : []),
    ...(agent === 'spec-review-agent' ? [
      '  spec-review approve --artifact-file <完整需求规格>',
      '  spec-review return-revision --target <intent|business_design|specification> --reason-file <理由> [--artifact-file <审查报告>]',
    ] : []),
    '',
    '问题树文件使用 JSON：{ summary, questions: [{ key, title, question, impact, options, recommendationOption, recommendationReason, proposedAuthority, activation }] }。',
    '决策解决文件使用 JSON：{ notes, agentDecisions: [{ key, optionId, reason }], humanDecisionKeys: [] }。',
    '规格审查分类文件使用 JSON：{ summary, gaps: [{ key, target, affectedSections, evidence, reason }] }。',
  ];
}

export function cloneBusinessAnalysisDraft(db: Db, source: Draft, target: Draft, agent: string) {
  const workflow = businessAnalysisWorkflow(agent);
  if (!workflow) throw new Error(`未知 Business Analysis Agent：${agent}`);
  const sourceState = state(db, source.draft_id);
  const resumeClarification = source.status === 'waiting_for_answers';
  const phase = resumeClarification ? sourceState.draft.workflow_phase : workflow.phases[0];
  db.prepare(`INSERT INTO business_analysis_drafts(draft_id, workflow_phase) VALUES(?, ?)`)
    .run(target.draft_id, phase);
  db.prepare(`
    INSERT INTO business_analysis_phase_artifacts(draft_id, phase, content, updated_at)
    SELECT ?, phase, content, updated_at
    FROM business_analysis_phase_artifacts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
}

export function initializeBusinessAnalysisDraft(db: Db, draft: Draft, agent: string) {
  const workflow = businessAnalysisWorkflow(agent);
  if (!workflow) throw new Error(`未知 Business Analysis Agent：${agent}`);
  db.prepare(`INSERT INTO business_analysis_drafts(draft_id, workflow_phase) VALUES(?, ?)`)
    .run(draft.draft_id, workflow.phases[0]);
}

export function runBusinessAnalysisCommand(input: Input) {
  const { db, execution, draft, command, flags } = input;
  const workflow = workflowFor(execution);
  const namespace = workflow.namespace;
  const current = state(db, draft.draft_id);

  if (command === `${namespace} status`) {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft.status_viewed_execution_id = execution.execution_id;
    return [commandResult(command, 'status_restored', [`Draft: ${draft.draft_id}`, `Phase: ${current.draft.workflow_phase}`]), '', workPacket(db, execution, draft)].join('\n');
  }

  assertViewed(draft, execution.execution_id);
  const phase = current.draft.workflow_phase;

  if (command === `${namespace} request-clarification`) {
    if (!['clarification_resolution', 'decision_resolution'].includes(phase)) throw new Error('当前工作包不能请求澄清');
    const proposalPhase = execution.agent === 'idea-context-agent' ? 'clarification_proposal' : 'decision_proposal';
    const proposal = proposalFor(db, draft.draft_id, proposalPhase);
    const resolutionPhase = execution.agent === 'idea-context-agent' ? 'clarification_resolution' : 'decision_resolution';
    const requestedKeys = parseJson(
      resolutionSchema,
      artifactFor(db, draft.draft_id, resolutionPhase) || '',
      execution.agent === 'idea-context-agent' ? '需求意图回答工作包' : '决策解决工作包',
    ).humanDecisionKeys;
    const questions = proposalQuestionsForResult(db, execution, proposal, requestedKeys);
    if (!questions.length) throw new Error('当前没有尚未发布的 HUMAN 问题；请读取回答并完成解决工作包');
    return terminal(input, 'request-clarification', {
      outcome: 'needs_input',
      summary: `需要用户确认 ${questions.length} 个当前活动的${execution.agent === 'idea-context-agent' ? '需求意图' : '业务方案'}问题`,
      questions,
      businessAnalysis: {
        stage: execution.agent === 'idea-context-agent' ? 'intent' : 'business_design',
        disposition: 'advance',
      },
    }, true);
  }

  const answerAuditPrefix = execution.agent === 'idea-context-agent'
    ? 'idea-context clarification-resolution'
    : execution.agent === 'business-design-agent'
      ? 'business-design decision-resolution'
      : null;
  if (answerAuditPrefix && (command === `${answerAuditPrefix} audit-complete` || command === `${answerAuditPrefix} expand`)) {
    const expectedPhase = execution.agent === 'idea-context-agent' ? 'clarification_resolution' : 'decision_resolution';
    if (phase !== expectedPhase) throw new Error(`${command} 只允许在 ${expectedPhase}`);
    assertAnswerAuditReady(db, execution, draft.draft_id, expectedPhase);
    const audit = bounded(required(flags, 'artifact'), '答案审查', 100_000);
    if (command.endsWith(' expand')) {
      return transition(
        input,
        phase,
        execution.agent === 'idea-context-agent' ? 'clarification_proposal' : 'decision_proposal',
        audit,
        '用户答案引入当前问题树无法表达的新语义，返回问题提出阶段增量补问',
      );
    }
    return transition(
      input,
      phase,
      execution.agent === 'idea-context-agent' ? 'synthesis' : 'solution',
      audit,
      '答案审查确认没有需要增量补问的新语义',
    );
  }

  if (command === 'business-design return-gap') {
    if (phase === 'finalize') throw new Error('FINALIZE 只能复核已经闭合的业务方案；需求意图缺口应在此前回流');
    return returnRevision(input, 'business_design', 'intent');
  }
  if (command === 'requirement-spec return-gap') {
    if (!['composition', 'verification'].includes(phase)) throw new Error('requirement-spec return-gap 只允许在 COMPOSITION 或 VERIFICATION');
    return returnRevision(input, 'specification');
  }
  if (command === 'spec-review return-revision') {
    if (phase !== 'verdict') throw new Error('spec-review return-revision 只允许在 VERDICT');
    return returnRevision(input, 'review');
  }

  if (command === 'spec-review approve') {
    if (phase !== 'verdict') throw new Error(`spec-review approve 只允许在 VERDICT；当前阶段是 ${phase}`);
    const classification = parseJson(reviewClassificationSchema, artifactFor(db, draft.draft_id, 'classification') || '', '规格缺口分类');
    if (classification.gaps.length) throw new Error('仍有阻断缺口，不能批准规格；请执行 spec-review return-revision');
    const artifact = bounded(required(flags, 'artifact'), '通过审查的完整需求规格');
    return terminal(input, 'approve', {
      outcome: 'completed',
      summary: '需求规格已通过独立审查',
      artifact: { title: '需求规格说明书', content: artifact },
      businessAnalysis: { stage: 'review', disposition: 'approved' },
    });
  }

  if (command === `${namespace} complete`) {
    if (phase !== 'finalize') throw new Error(`${namespace} complete 只允许在 FINALIZE；当前阶段是 ${phase}`);
    const artifactPhase = execution.agent === 'idea-context-agent' ? 'synthesis'
      : execution.agent === 'business-design-agent' ? 'solution'
        : 'verification';
    const artifact = artifactFor(db, draft.draft_id, artifactPhase);
    if (!artifact) throw new Error(`缺少 ${artifactPhase} 正式产物`);
    const stage = execution.agent === 'idea-context-agent' ? 'intent'
      : execution.agent === 'business-design-agent' ? 'business_design'
        : 'specification';
    const title = execution.agent === 'idea-context-agent' ? '需求意图简报'
      : execution.agent === 'business-design-agent' ? '业务方案'
        : '需求规格说明书';
    return terminal(input, 'complete', {
      outcome: 'completed',
      summary: `${title}已完成`,
      artifact: { title, content: artifact },
      businessAnalysis: { stage, disposition: 'advance' },
    });
  }

  const definition = workflow.definitions[phase];
  if (!definition?.submit || command !== definition.submit) {
    throw new Error(`命令 ${command} 不属于当前 ${definition?.label || phase} 工作包`);
  }
  const artifact = bounded(required(flags, 'artifact'), `${definition.label} 工作包`);

  if (phase === 'clarification_proposal') {
    const proposal = parseJson(proposalSchema, artifact, '需求意图问题树');
    validateProposalRound(db, execution, proposal);
    return transition(input, phase, proposal.questions.length ? 'clarification_resolution' : 'synthesis', artifact, proposal.questions.length ? '发现需要在回答阶段关闭的意图歧义' : '没有实质意图歧义');
  }

  if (phase === 'decision_proposal') {
    const proposal = parseJson(proposalSchema, artifact, '业务决策树');
    validateProposalRound(db, execution, proposal);
    return transition(input, phase, 'decision_resolution', artifact, '业务决策树已完整提出，尚未回答');
  }

  if (phase === 'clarification_resolution' || phase === 'decision_resolution') {
    const intentResolution = phase === 'clarification_resolution';
    const proposal = proposalFor(db, draft.draft_id, intentResolution ? 'clarification_proposal' : 'decision_proposal');
    const resolution = parseJson(resolutionSchema, artifact, intentResolution ? '需求意图回答工作包' : '决策解决工作包');
    const proposedKeys = new Set(proposal.questions.map((question) => question.key));
    const resolutionKeys = [...resolution.agentDecisions.map((decision) => decision.key), ...resolution.humanDecisionKeys];
    const unknown = resolutionKeys.filter((key) => !proposedKeys.has(key));
    if (unknown.length) throw new Error(`回答工作包引用未知 key：${unknown.join('、')}`);
    const duplicated = resolutionKeys.filter((key, index) => resolutionKeys.indexOf(key) !== index);
    if (duplicated.length) throw new Error(`同一决策不能同时交给 Agent 和 HUMAN：${[...new Set(duplicated)].join('、')}`);
    const existingRows = new Map(questionRows(db, execution.task_id, execution.agent).map((row) => [row.decision_key, row]));
    for (const question of proposal.questions) {
      const existing = existingRows.get(question.key);
      if (!existing) continue;
      if (existing.decision_authority === 'human' && !resolution.humanDecisionKeys.includes(question.key)) {
        throw new Error(`已经发布给 HUMAN 的节点不能改由 Agent 回答或从回答工作包移除：${question.key}`);
      }
      if (existing.decision_authority === 'agent') {
        const repeatedDecision = resolution.agentDecisions.find((decision) => decision.key === question.key);
        if (!repeatedDecision) throw new Error(`已经由 Agent 关闭的节点不能改交 HUMAN 或从回答工作包移除：${question.key}`);
        if (existing.selected_option_id && existing.selected_option_id !== repeatedDecision.optionId) {
          throw new Error(`已经由 Agent 关闭的节点不能更换答案：${question.key}`);
        }
      }
    }
    const mode = decisionMode(db, execution.task_id);
    if (mode === 'fully_autonomous' && resolution.humanDecisionKeys.length) {
      throw new Error('完全自主模式不得形成 HUMAN 决策批次');
    }
    db.transaction(() => {
      for (const decision of resolution.agentDecisions) publishAgentDecision(db, execution, proposal, decision);
      recomputeTaskQuestionApplicabilityInDb(db, execution.task_id, execution.agent, null);
      saveArtifact(db, draft.draft_id, phase, artifact);
    })();
    if (resolution.humanDecisionKeys.length) {
      const published = new Map(questionRows(db, execution.task_id, execution.agent).map((row) => [row.decision_key, row]));
      const unpublished = resolution.humanDecisionKeys.filter((key) => !published.has(key));
      if (unpublished.length) {
        return [commandResult(command, 'accepted', [`HUMAN Decisions: ${resolution.humanDecisionKeys.length}`]), '', '# NEXT', '', `- Action: \`${namespace} request-clarification\``].join('\n');
      }
      const unresolvedHuman = resolution.humanDecisionKeys.filter((key) => {
        const row = published.get(key);
        return !row || !['answered', 'resolved', 'not_applicable', 'superseded'].includes(row.status);
      });
      if (unresolvedHuman.length) {
        throw new Error(`仍在等待用户回答：${unresolvedHuman.join('、')}`);
      }
      return [
        commandResult(command, 'answer_audit_required', [
          `Agent Answers: ${resolution.agentDecisions.length}`,
          `HUMAN Answers: ${resolution.humanDecisionKeys.length}`,
        ]),
        '',
        '# NEXT',
        '',
        `- No New Branch: \`${namespace} ${intentResolution ? 'clarification-resolution' : 'decision-resolution'} audit-complete --artifact-file <答案审查>\``,
        `- New Branch Required: \`${namespace} ${intentResolution ? 'clarification-resolution' : 'decision-resolution'} expand --artifact-file <答案审查与新增分支依据>\``,
      ].join('\n');
    }
    recomputeTaskQuestionApplicabilityInDb(db, execution.task_id, execution.agent, null);
    const rows = new Map(questionRows(db, execution.task_id, execution.agent).map((row) => [row.decision_key, row]));
    const unresolved = proposal.questions.filter((question) => {
      const row = rows.get(question.key);
      return !row || !['answered', 'resolved', 'not_applicable', 'superseded'].includes(row.status);
    });
    if (unresolved.length) throw new Error(`${intentResolution ? '需求意图问题树' : '业务决策树'}仍有未关闭节点：${unresolved.map((question) => question.key).join('、')}`);
    return [
      commandResult(command, 'answer_audit_required', [
        `Agent Answers: ${resolution.agentDecisions.length}`,
        'HUMAN Answers: 0',
      ]),
      '',
      '# NEXT',
      '',
      `- No New Branch: \`${namespace} ${intentResolution ? 'clarification-resolution' : 'decision-resolution'} audit-complete --artifact-file <答案审查>\``,
      `- New Branch Required: \`${namespace} ${intentResolution ? 'clarification-resolution' : 'decision-resolution'} expand --artifact-file <答案审查与新增分支依据>\``,
    ].join('\n');
  }

  if (phase === 'classification') {
    parseJson(reviewClassificationSchema, artifact, '规格缺口分类');
  }

  const phaseIndex = workflow.phases.indexOf(phase);
  const next = workflow.phases[phaseIndex + 1];
  if (!next) throw new Error(`${phase} 没有下一工作包`);
  return transition(input, phase, next, artifact, `${definition.label} 工作包完成`);
}
