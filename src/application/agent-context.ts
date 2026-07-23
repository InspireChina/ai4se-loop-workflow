import { createHash } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { documentKindLabel } from '../domain/terminology';
import { recoveryItemForPrompt, type RecoveryItem } from './recovery-items';
import type { DelegationEnvelope, DocumentComment, ExecutionAttemptView, RuntimeInputRequest } from './tasks';

export const agentContextProtocol = 'loop-agent-context/v1';

export type AgentContextResource = {
  ref: string;
  kind: 'document' | 'slice_spec' | 'decision' | 'runtime_input' | 'feedback' | 'execution' | 'recovery';
  title: string;
  scope: 'task' | `unit:${number}`;
  deliveryUnit: number | null;
  revision: number | null;
  status: string;
  authority: 'authoritative' | 'active_obligation' | 'execution_evidence' | 'supporting' | 'historical';
  updatedAt: string | null;
  summary: string;
  content: unknown;
};

export type AgentContextIndexEntry = Omit<AgentContextResource, 'content'>;

export type AgentContextSnapshot = {
  protocol: typeof agentContextProtocol;
  snapshotId: string;
  work: {
    taskId: string;
    title: string;
    agent: string;
    lane: string;
    flow: string;
    deliveryUnit: number | null;
    objective: string;
    repositoryBaseCommit: string | null;
  };
  authoritativeFacts: {
    requirement: {
      title: string;
      description: string | null;
      itemType: string;
      priority: string | null;
      link: string | null;
    };
    lifecycle: {
      agileStatus: string;
      lanes: unknown[];
      progress: { analysis: number; development: number; verification: number; total: number };
    };
    currentDeliveryUnit: { index: number; title: string } | null;
    deliveryUnits: { index: number; title: string }[];
    currentSliceSpec: unknown | null;
    answeredDecisionKeys: string[];
    userDecisions: unknown[];
  };
  activeObligations: {
    questions: unknown[];
    runtimeInputs: unknown[];
    feedback: unknown[];
    recovery: unknown[];
  };
  handoff: unknown[];
  requiredContextRefs: string[];
  startupIndex: AgentContextIndexEntry[];
  resourceCount: number;
  resources: AgentContextResource[];
};

type TaskContext = Awaited<ReturnType<typeof import('./tasks').getTaskContext>>;

function parseJson(value: string | null | undefined, fallback: unknown = null) {
  if (!value) return fallback;
  try { return JSON.parse(value) as unknown; }
  catch { return { raw: value }; }
}

function plainText(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function compact(value: unknown, limit = 240) {
  const text = plainText(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function scope(storyIndex: number | null): AgentContextResource['scope'] {
  return storyIndex ? `unit:${storyIndex}` : 'task';
}

function indexEntry(resource: AgentContextResource): AgentContextIndexEntry {
  const { content: _content, ...entry } = resource;
  return entry;
}

function latestBy<T>(items: T[], revision: (item: T) => number) {
  return [...items].sort((left, right) => revision(right) - revision(left))[0] || null;
}

function relevantToExecution(storyIndex: number | null, itemStoryIndex: number | null) {
  return itemStoryIndex == null || itemStoryIndex === storyIndex;
}

function feedbackPromptValue(comment: DocumentComment) {
  return {
    commentId: comment.comment_id,
    documentId: comment.document_id,
    documentRevision: comment.document_revision,
    content: comment.content,
    quotedText: comment.quoted_text,
    intent: comment.intent,
    feedbackStatus: comment.feedback_status,
    disposition: comment.disposition,
    targetStage: comment.target_stage,
    targetAgent: comment.target_agent,
    targetDeliveryUnit: comment.target_story_index,
    reason: comment.triage_reason,
    acceptance: parseJson(comment.acceptance_json, []),
    resolutionClaim: parseJson(comment.resolution_claim_json),
    verification: parseJson(comment.verification_json),
  };
}

function runtimeInputValue(input: RuntimeInputRequest) {
  return {
    requestId: input.request_id,
    sourceAgent: input.source_agent,
    deliveryUnit: input.story_index,
    title: input.title,
    question: input.question,
    why: input.why,
    recommendation: input.recommendation,
    answer: input.answer,
    status: input.status,
    sourceExecutionId: input.source_execution_id,
  };
}

function executionValue(attempt: ExecutionAttemptView) {
  return {
    executionId: attempt.execution_id,
    agent: attempt.agent,
    flow: attempt.pipeline,
    lane: attempt.lane,
    deliveryUnit: attempt.story_index,
    attempt: attempt.attempt,
    status: attempt.status,
    outcome: attempt.result_outcome,
    summary: attempt.result_summary,
    baseCommit: attempt.base_commit,
    codeCommit: attempt.code_commit,
    verificationId: attempt.verification_id,
    error: attempt.last_error,
    startedAt: attempt.started_at,
    finishedAt: attempt.finished_at,
  };
}

function sliceSpecValue<T extends { spec_json: string }>(spec: T) {
  const { spec_json: _specJson, ...metadata } = spec;
  return { ...metadata, spec: parseJson(spec.spec_json) };
}

const requiredDocumentKinds: Record<string, string[]> = {
  'backlog-agent': ['context'],
  'story-splitter-agent': ['context', 'repro', 'delivery_split'],
  'repro-agent': ['context', 'repro'],
  'analyst-agent': ['context', 'delivery_split', 'analysis', 'test_result'],
  'dev-agent': ['analysis', 'dev_note', 'test_result'],
  'test-agent': ['analysis', 'dev_note', 'test_result'],
  'review-agent': ['context', 'delivery_split', 'analysis', 'dev_note', 'test_result'],
};

function handoffAttempts(agent: string, storyIndex: number | null, attempts: ExecutionAttemptView[]) {
  const relevant = attempts.filter((attempt) =>
    agent === 'review-agent' || relevantToExecution(storyIndex, attempt.story_index));
  const latest = new Map<string, ExecutionAttemptView>();
  for (const attempt of relevant) latest.set(`${attempt.agent}:${attempt.story_index ?? 'task'}`, attempt);
  return [...latest.values()]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, agent === 'review-agent' ? 24 : 8)
    .map(executionValue);
}

export function buildAgentContextSnapshot(input: {
  delegation: DelegationEnvelope;
  full: TaskContext;
  activeFeedback: DocumentComment[];
  activeRecovery: RecoveryItem[];
  repositoryBaseCommit?: string | null;
}) {
  const { delegation, full } = input;
  const currentStory = delegation.storyIndex
    ? full.stories.find((story) => story.story_index === delegation.storyIndex) || null
    : null;
  const currentSpecs = full.storySpecs.filter((spec) => spec.story_index === delegation.storyIndex);
  const currentSpec = latestBy(
    currentSpecs.filter((spec) => spec.status !== 'superseded'),
    (spec) => spec.revision,
  ) || latestBy(currentSpecs, (spec) => spec.revision);
  const userDecisions = full.questions
    .filter((question) => relevantToExecution(delegation.storyIndex, question.story_index) && Boolean(question.answer))
    .map((question) => ({
      decisionKey: question.decision_key,
      title: question.title,
      question: question.question,
      answer: question.answer,
      deliveryUnit: question.story_index,
      specRevision: question.spec_revision,
      resolvedAt: question.resolved_at,
    }));
  const answeredDecisionKeys = [...new Set(userDecisions
    .map((decision) => decision.decisionKey)
    .filter((key): key is string => Boolean(key)))];
  const activeQuestions = full.questions
    .filter((question) => relevantToExecution(delegation.storyIndex, question.story_index) && !question.answer && question.status !== 'superseded')
    .map((question) => ({
      questionId: question.question_id,
      title: question.title,
      question: question.question,
      why: question.why,
      recommendation: question.recommendation,
      deliveryUnit: question.story_index,
      status: question.status,
    }));
  const activeRuntimeInputs = full.runtimeInputs
    .filter((runtimeInput) =>
      relevantToExecution(delegation.storyIndex, runtimeInput.story_index)
      && runtimeInput.source_agent === delegation.agent
      && ['pending', 'answered'].includes(runtimeInput.status))
    .map(runtimeInputValue);
  const feedbackBatchIds = new Set([delegation.feedbackId, ...(delegation.feedbackIds || [])].filter(Boolean));
  const activeFeedback = full.documentComments.filter((comment) =>
    feedbackBatchIds.has(comment.comment_id)
    || input.activeFeedback.some((active) => active.comment_id === comment.comment_id));

  const resources: AgentContextResource[] = [];
  for (const document of full.documents) {
    resources.push({
      ref: `DOC:${document.document_id}`,
      kind: 'document',
      title: document.title,
      scope: scope(document.story_index),
      deliveryUnit: document.story_index,
      revision: document.revision,
      status: 'active',
      authority: ['context', 'delivery_split', 'analysis'].includes(document.kind) ? 'supporting' : 'execution_evidence',
      updatedAt: document.updated_at,
      summary: `${documentKindLabel(document.kind)} · ${compact(document.content)}`,
      content: {
        documentId: document.document_id,
        kind: document.kind,
        title: document.title,
        revision: document.revision,
        format: document.format,
        sourceAgent: document.source_agent,
        deliveryUnit: document.story_index,
        content: document.content,
      },
    });
  }
  for (const spec of full.storySpecs) {
    resources.push({
      ref: `SPEC:${spec.spec_id}:r${spec.revision}`,
      kind: 'slice_spec',
      title: `交付单元 ${spec.story_index} Slice Spec r${spec.revision}`,
      scope: scope(spec.story_index),
      deliveryUnit: spec.story_index,
      revision: spec.revision,
      status: spec.status,
      authority: spec.status === 'resolved' ? 'authoritative' : spec.status === 'superseded' ? 'historical' : 'supporting',
      updatedAt: spec.resolved_at || spec.created_at,
      summary: compact(parseJson(spec.spec_json)),
      content: sliceSpecValue(spec),
    });
  }
  for (const question of full.questions) {
    const value = {
      questionId: question.question_id,
      decisionKey: question.decision_key,
      title: question.title,
      question: question.question,
      answer: question.answer,
      why: question.why,
      recommendation: question.recommendation,
      alternatives: parseJson(question.alternatives_json, []),
      deliveryUnit: question.story_index,
      status: question.status,
      specRevision: question.spec_revision,
    };
    resources.push({
      ref: `DECISION:${question.question_id}`,
      kind: 'decision',
      title: question.title,
      scope: scope(question.story_index),
      deliveryUnit: question.story_index,
      revision: question.spec_revision,
      status: question.status,
      authority: question.answer ? 'authoritative' : 'supporting',
      updatedAt: question.updated_at,
      summary: compact(question.answer ? `${question.question} 答复：${question.answer}` : question.question),
      content: value,
    });
  }
  for (const runtimeInput of full.runtimeInputs) {
    const value = runtimeInputValue(runtimeInput);
    resources.push({
      ref: `RUNTIME:${runtimeInput.request_id}`,
      kind: 'runtime_input',
      title: runtimeInput.title,
      scope: scope(runtimeInput.story_index),
      deliveryUnit: runtimeInput.story_index,
      revision: null,
      status: runtimeInput.status,
      authority: runtimeInput.answer ? 'authoritative' : 'supporting',
      updatedAt: runtimeInput.updated_at,
      summary: compact(runtimeInput.answer ? `${runtimeInput.question} 答复：${runtimeInput.answer}` : runtimeInput.question),
      content: value,
    });
  }
  for (const comment of full.documentComments) {
    const value = feedbackPromptValue(comment);
    const commentStoryIndex = comment.target_story_index
      ?? full.documents.find((document) => document.document_id === comment.document_id)?.story_index
      ?? null;
    resources.push({
      ref: `FEEDBACK:${comment.comment_id}`,
      kind: 'feedback',
      title: `文档反馈 ${comment.comment_id}`,
      scope: scope(commentStoryIndex),
      deliveryUnit: commentStoryIndex,
      revision: comment.document_revision,
      status: comment.feedback_status,
      authority: activeFeedback.some((active) => active.comment_id === comment.comment_id)
        || ['in_progress', 'verifying', 'reopened'].includes(comment.feedback_status)
        ? 'active_obligation'
        : 'historical',
      updatedAt: comment.updated_at,
      summary: compact(comment.content),
      content: value,
    });
  }
  for (const attempt of full.executionAttempts) {
    const value = executionValue(attempt);
    resources.push({
      ref: `EXEC:${attempt.execution_id}`,
      kind: 'execution',
      title: `${attempt.agent} · attempt ${attempt.attempt}`,
      scope: scope(attempt.story_index),
      deliveryUnit: attempt.story_index,
      revision: attempt.attempt,
      status: attempt.status,
      authority: 'execution_evidence',
      updatedAt: attempt.finished_at || attempt.started_at || attempt.created_at,
      summary: compact(attempt.result_summary || attempt.last_error || `${attempt.agent} ${attempt.status}`),
      content: value,
    });
  }
  for (const recovery of full.recoveryItems) {
    const value = recoveryItemForPrompt(recovery);
    resources.push({
      ref: `RECOVERY:${recovery.recovery_id}`,
      kind: 'recovery',
      title: `${recovery.recovery_id} · ${recovery.summary}`,
      scope: scope(recovery.story_index),
      deliveryUnit: recovery.story_index,
      revision: recovery.failure_count,
      status: recovery.status,
      authority: ['pending', 'claimed', 'reopened'].includes(recovery.status) ? 'active_obligation' : 'historical',
      updatedAt: recovery.updated_at,
      summary: compact(recovery.summary),
      content: value,
    });
  }

  const required = new Set<string>();
  if (currentSpec) required.add(`SPEC:${currentSpec.spec_id}:r${currentSpec.revision}`);
  if (delegation.agent === 'review-agent') {
    for (const story of full.stories) {
      const latest = latestBy(
        full.storySpecs.filter((spec) => spec.story_index === story.story_index && spec.status !== 'superseded'),
        (spec) => spec.revision,
      );
      if (latest) required.add(`SPEC:${latest.spec_id}:r${latest.revision}`);
    }
  }
  if (delegation.agent === 'feedback-agent') {
    const affectedUnits = new Set(activeFeedback.map((comment) =>
      comment.target_story_index
      || full.documents.find((document) => document.document_id === comment.document_id)?.story_index
      || null,
    ).filter((value): value is number => Boolean(value)));
    for (const storyIndex of affectedUnits) {
      const latest = latestBy(
        full.storySpecs.filter((spec) => spec.story_index === storyIndex && spec.status !== 'superseded'),
        (spec) => spec.revision,
      );
      if (latest) required.add(`SPEC:${latest.spec_id}:r${latest.revision}`);
    }
  }
  const kinds = requiredDocumentKinds[delegation.agent] || [];
  for (const document of full.documents) {
    const roleScope = delegation.agent === 'review-agent'
      ? true
      : relevantToExecution(delegation.storyIndex, document.story_index);
    if (roleScope && kinds.includes(document.kind)) required.add(`DOC:${document.document_id}`);
    if (activeFeedback.some((comment) => comment.document_id === document.document_id)) required.add(`DOC:${document.document_id}`);
  }
  for (const comment of activeFeedback) required.add(`FEEDBACK:${comment.comment_id}`);
  for (const recovery of input.activeRecovery) required.add(`RECOVERY:${recovery.recovery_id}`);
  for (const runtimeInput of activeRuntimeInputs) required.add(`RUNTIME:${runtimeInput.requestId}`);

  const relevantResources = resources.filter((resource) =>
    required.has(resource.ref)
    || relevantToExecution(delegation.storyIndex, resource.deliveryUnit));
  const startupIndex = [...relevantResources]
    .sort((left, right) => Number(required.has(right.ref)) - Number(required.has(left.ref)) || (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    .slice(0, 48)
    .map(indexEntry);
  const snapshotBody = {
    protocol: agentContextProtocol as typeof agentContextProtocol,
    work: {
      taskId: delegation.taskId,
      title: delegation.title,
      agent: delegation.agent,
      lane: delegation.lane,
      flow: delegation.pipeline,
      deliveryUnit: delegation.storyIndex,
      objective: delegation.description,
      repositoryBaseCommit: input.repositoryBaseCommit || null,
    },
    authoritativeFacts: {
      requirement: {
        title: full.task.title,
        description: full.task.description,
        itemType: full.task.item_type,
        priority: full.task.priority,
        link: full.task.link,
      },
      lifecycle: {
        agileStatus: full.task.agile_status,
        lanes: full.lanes,
        progress: {
          analysis: full.task.analysis_index,
          development: full.task.dev_index,
          verification: full.task.test_index,
          total: full.task.total_stories,
        },
      },
      currentDeliveryUnit: currentStory ? { index: currentStory.story_index, title: currentStory.title } : null,
      deliveryUnits: full.stories.map((story) => ({ index: story.story_index, title: story.title })),
      currentSliceSpec: currentSpec ? sliceSpecValue(currentSpec) : null,
      answeredDecisionKeys,
      userDecisions,
    },
    activeObligations: {
      questions: activeQuestions,
      runtimeInputs: activeRuntimeInputs,
      feedback: activeFeedback.map(feedbackPromptValue),
      recovery: input.activeRecovery.map(recoveryItemForPrompt),
    },
    handoff: handoffAttempts(delegation.agent, delegation.storyIndex, full.executionAttempts),
    requiredContextRefs: [...required],
    startupIndex,
    resourceCount: resources.length,
    resources,
  };
  const snapshotId = `CTX-${createHash('sha256').update(JSON.stringify(snapshotBody)).digest('hex').slice(0, 16)}`;
  return { ...snapshotBody, snapshotId } satisfies AgentContextSnapshot;
}

export async function getExecutionAgentContextSnapshot(executionId: string) {
  const db = await databaseConnection();
  const row = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(executionId) as { input_json: string } | undefined;
  if (!row) throw new Error('当前 Agent execution 不存在');
  const stored = JSON.parse(row.input_json) as { contextSnapshot?: AgentContextSnapshot };
  if (!stored.contextSnapshot || stored.contextSnapshot.protocol !== agentContextProtocol) throw new Error('当前 execution 没有可读取的 Context Snapshot');
  return stored.contextSnapshot;
}

export function renderAgentContextOverview(snapshot: AgentContextSnapshot) {
  return [
    '# Current Work',
    JSON.stringify(snapshot.work, null, 2),
    '',
    '# Authoritative Facts',
    JSON.stringify(snapshot.authoritativeFacts, null, 2),
    '',
    '# Active Obligations',
    JSON.stringify(snapshot.activeObligations, null, 2),
    '',
    '# Latest Handoff',
    JSON.stringify(snapshot.handoff, null, 2),
    '',
    `Context resources: ${snapshot.resourceCount}. Use agent-context list/search/get to progressively disclose details.`,
  ].join('\n');
}

export function listAgentContextResources(snapshot: AgentContextSnapshot, filters: { kind?: string; scope?: string } = {}) {
  return snapshot.resources.filter((resource) => {
    if (filters.kind && resource.kind !== filters.kind) return false;
    if (filters.scope === 'current' && !relevantToExecution(snapshot.work.deliveryUnit, resource.deliveryUnit)) return false;
    if (filters.scope === 'task' && resource.deliveryUnit !== null) return false;
    return true;
  });
}

export function renderAgentContextList(snapshot: AgentContextSnapshot, filters: { kind?: string; scope?: string } = {}) {
  const resources = listAgentContextResources(snapshot, filters);
  if (!resources.length) return 'No context resources matched.';
  const visible = resources.slice(0, 100);
  const lines = visible.map((resource) =>
    `- ${resource.ref} | ${resource.kind} | ${resource.scope} | ${resource.status} | r${resource.revision ?? '-'} | ${resource.title} | ${resource.summary}`,
  );
  if (resources.length > visible.length) lines.push(`- … ${resources.length - visible.length} more resources; narrow with --kind or --scope.`);
  return lines.join('\n');
}

export function renderAgentContextResource(snapshot: AgentContextSnapshot, ref: string) {
  const resource = snapshot.resources.find((item) => item.ref === ref);
  if (!resource) throw new Error(`Context reference not found: ${ref}`);
  return [
    `# ${resource.ref} · ${resource.title}`,
    `kind=${resource.kind} scope=${resource.scope} status=${resource.status} revision=${resource.revision ?? '-'} authority=${resource.authority}`,
    '',
    typeof resource.content === 'string' ? resource.content : JSON.stringify(resource.content, null, 2),
  ].join('\n');
}

export function renderAgentContextSearch(snapshot: AgentContextSnapshot, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) throw new Error('agent-context search requires --query');
  const matches = snapshot.resources.flatMap((resource) => {
    const haystack = `${resource.title}\n${resource.summary}\n${plainText(resource.content)}`.toLocaleLowerCase();
    const index = haystack.indexOf(normalized);
    if (index < 0) return [];
    const source = plainText(resource.content).replace(/\s+/g, ' ');
    const sourceIndex = source.toLocaleLowerCase().indexOf(normalized);
    const start = Math.max(0, sourceIndex - 100);
    return [{ resource, snippet: compact(source.slice(start, start + 420), 420) }];
  }).slice(0, 20);
  if (!matches.length) return `No context resources matched: ${query}`;
  return matches.map(({ resource, snippet }) => `- ${resource.ref} | ${resource.title}\n  ${snippet}`).join('\n');
}

export function renderAgentContextEvidence(snapshot: AgentContextSnapshot, stage?: string) {
  const stageAgents: Record<string, string[]> = {
    context: ['backlog-agent'], repro: ['repro-agent'], plan: ['story-splitter-agent'],
    analysis: ['analyst-agent'], dev: ['dev-agent'], test: ['test-agent'], review: ['review-agent'],
  };
  const allowedAgents = stage ? stageAgents[stage] || [] : [];
  const resources = snapshot.resources.filter((resource) => {
    if (!['execution', 'recovery', 'feedback'].includes(resource.kind)) return false;
    if (!stage || resource.kind !== 'execution') return true;
    const content = resource.content as { agent?: string };
    return allowedAgents.includes(content.agent || '');
  });
  if (!resources.length) return 'No execution evidence matched.';
  const visible = resources.slice(0, 100);
  const lines = visible.map((resource) => `- ${resource.ref} | ${resource.status} | ${resource.title} | ${resource.summary}`);
  if (resources.length > visible.length) lines.push(`- … ${resources.length - visible.length} more evidence resources; narrow with --stage.`);
  return lines.join('\n');
}

export function renderAgentContextHistory(snapshot: AgentContextSnapshot, ref: string) {
  const target = snapshot.resources.find((resource) => resource.ref === ref);
  if (!target) throw new Error(`Context reference not found: ${ref}`);
  const history = snapshot.resources
    .filter((resource) => resource.kind === target.kind && resource.scope === target.scope && (
      resource.kind !== 'document'
      || (resource.content as { kind?: string }).kind === (target.content as { kind?: string }).kind
    ))
    .sort((left, right) => (right.revision || 0) - (left.revision || 0));
  return history.map((resource) => `- ${resource.ref} | ${resource.status} | r${resource.revision ?? '-'} | ${resource.updatedAt || ''} | ${resource.summary}`).join('\n');
}
