import { createHash } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { documentKindLabel } from '../domain/terminology';
import { recoveryItemForPrompt, type RecoveryItem } from './recovery-items';
import type { DelegationEnvelope, DocumentComment, ExecutionAttemptView, FeedbackGroup, RuntimeInputRequest } from './tasks';

export const agentContextProtocol = 'loop-agent-context/v2';

export type AgentContextResource = {
  ref: string;
  kind: 'document' | 'delivery_spec' | 'decision' | 'runtime_input' | 'feedback' | 'execution' | 'recovery';
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

type DeliveryUnitContextValue = {
  index: number;
  key: string | null;
  title: string;
  actor: string | null;
  trigger: string | null;
  observableOutcome: string | null;
  acceptance: string | null;
  sourceRefs: {
    key: string;
    kind: 'change' | 'preserve' | 'technical' | 'acceptance';
    content: string;
    sourceRef: string;
  }[];
  dependsOn: number[];
};

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
    currentDeliveryUnit: DeliveryUnitContextValue | null;
    deliveryUnits: DeliveryUnitContextValue[];
    currentDeliverySpec: unknown | null;
    answeredDecisionKeys: string[];
    userDecisions: unknown[];
    requirementContextResume: unknown | null;
  };
  activeObligations: {
    questions: unknown[];
    runtimeInputs: unknown[];
    feedback: unknown[];
    recovery: unknown[];
  };
  recentExecutionEvidence: unknown[];
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

function requirementBaseline(content: string | null | undefined) {
  if (!content) return null;
  const boundaries = ['\n## DECISIONS', '\n## OPEN QUESTIONS', '\n## TO-BE']
    .map((heading) => content.indexOf(heading))
    .filter((index) => index >= 0);
  return content.slice(0, boundaries.length ? Math.min(...boundaries) : content.length).trimEnd();
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

function deliveryUnitContextValue(story: TaskContext['stories'][number]): DeliveryUnitContextValue {
  return {
    index: story.story_index,
    key: story.unit_key,
    title: story.title,
    actor: story.actor,
    trigger: story.trigger_condition,
    observableOutcome: story.observable_outcome,
    acceptance: story.acceptance,
    sourceRefs: story.context_links.map((link) => ({
      key: link.source_key,
      kind: link.source_kind,
      content: link.content,
      sourceRef: link.source_ref,
    })),
    dependsOn: story.depends_on_story_indexes,
  };
}

function feedbackPromptValue(comment: DocumentComment, group?: FeedbackGroup) {
  return {
    commentId: comment.comment_id,
    documentId: comment.document_id,
    documentRevision: comment.document_revision,
    content: comment.content,
    quotedText: comment.quoted_text,
    intent: comment.intent,
    feedbackStatus: comment.feedback_status,
    batchId: group?.batch_id || comment.feedback_batch_id,
    groupId: group?.group_id || null,
    groupKey: group?.group_key || null,
    workType: group?.work_type || null,
    groupStatus: group?.status || null,
    affectedDeliveryUnits: group ? parseJson(group.affected_story_indexes_json, []) : [],
    appendedDeliveryUnits: group?.delivery_unit_indexes || [],
    reason: group?.reason || comment.triage_reason,
    acceptance: group ? parseJson(group.acceptance_json, []) : parseJson(comment.acceptance_json, []),
    response: group?.response_text || null,
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
    verdict: attempt.result_verdict,
    summary: attempt.result_summary,
    baseCommit: attempt.base_commit,
    codeCommit: attempt.code_commit,
    verificationId: attempt.verification_id,
    error: attempt.last_error,
    startedAt: attempt.started_at,
    finishedAt: attempt.finished_at,
  };
}

function verificationDeliverySpecProjection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const spec = value as Record<string, unknown>;
  const rawHandoff = spec.handoff;
  if (!rawHandoff || typeof rawHandoff !== 'object' || Array.isArray(rawHandoff)) return spec;
  const {
    implementationGuidance: _implementationGuidance,
    ...verificationContract
  } = rawHandoff as Record<string, unknown>;
  return { ...spec, handoff: verificationContract };
}

function deliverySpecValue<T extends { spec_json: string }>(spec: T, agent: string) {
  const { spec_json: _specJson, ...metadata } = spec;
  const parsed = parseJson(spec.spec_json);
  return {
    ...metadata,
    spec: agent === 'test-agent' ? verificationDeliverySpecProjection(parsed) : parsed,
  };
}

const requiredDocumentKinds: Record<string, string[]> = {
  'idea-context-agent': [],
  'business-design-agent': ['ba_intent'],
  'requirement-spec-agent': ['ba_intent', 'ba_solution'],
  'spec-review-agent': ['ba_intent', 'ba_solution', 'ba_spec'],
  'backlog-agent': ['context'],
  'story-splitter-agent': ['context', 'repro', 'delivery_split'],
  'repro-agent': ['context', 'repro'],
  'analyst-agent': ['context', 'delivery_split', 'analysis', 'test_result'],
  'dev-agent': ['analysis', 'dev_note', 'test_result'],
  'test-agent': ['context', 'repro', 'delivery_split', 'test_result'],
  'review-agent': ['context', 'delivery_split', 'analysis', 'dev_note', 'test_result'],
};

function recentExecutionEvidence(agent: string, storyIndex: number | null, attempts: ExecutionAttemptView[]) {
  const relevant = attempts.filter((attempt) =>
    (agent === 'review-agent' || relevantToExecution(storyIndex, attempt.story_index))
    && (agent !== 'test-agent' || attempt.agent === 'test-agent'));
  const latest = new Map<string, ExecutionAttemptView>();
  for (const attempt of relevant) latest.set(`${attempt.agent}:${attempt.story_index ?? 'task'}`, attempt);
  return [...latest.values()]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, agent === 'review-agent' ? 24 : 8)
    .map(executionValue);
}

const testVisibleDocumentKinds = new Set(['context', 'repro', 'delivery_split', 'test_result']);

function resourceVisibleToAgent(resource: AgentContextResource, agent: string, storyIndex: number | null) {
  if (agent !== 'test-agent') return true;
  if (!relevantToExecution(storyIndex, resource.deliveryUnit)) return false;
  if (resource.kind === 'document') {
    const content = resource.content as { kind?: string; sourceAgent?: string };
    if (!testVisibleDocumentKinds.has(content.kind || '')) return false;
    return content.kind !== 'test_result' || content.sourceAgent === 'test-agent';
  }
  if (resource.kind === 'delivery_spec') {
    return resource.deliveryUnit === storyIndex && resource.status === 'resolved';
  }
  if (resource.kind === 'runtime_input') {
    const content = resource.content as { sourceAgent?: string };
    return content.sourceAgent === 'test-agent';
  }
  if (resource.kind === 'execution') {
    const content = resource.content as { agent?: string };
    return content.agent === 'test-agent';
  }
  return true;
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
  const currentSpecs = full.deliverySpecs.filter((spec) => spec.story_index === delegation.storyIndex);
  const currentSpec = latestBy(
    currentSpecs.filter((spec) =>
      delegation.agent === 'test-agent'
        ? spec.status === 'resolved'
        : spec.status !== 'superseded'),
    (spec) => spec.revision,
  ) || (delegation.agent === 'test-agent'
    ? null
    : latestBy(currentSpecs, (spec) => spec.revision));
  const projectedQuestions = full.questions.filter((question) =>
    ['pending', 'answered', 'resolved'].includes(question.status));
  const userDecisions = projectedQuestions
    .filter((question) =>
      relevantToExecution(delegation.storyIndex, question.story_index)
      && ['answered', 'resolved'].includes(question.status)
      && Boolean(question.answer))
    .map((question) => ({
      decisionKey: question.decision_key,
      title: question.title,
      question: question.question,
      answer: question.answer,
      selectedOptionId: question.selected_option_id,
      selectedOption: (parseJson(question.alternatives_json, []) as { id?: string; label?: string; consequences?: string[] }[])
        .find((option) => option.id === question.selected_option_id) || null,
      activatedBy: parseJson(question.activation_json, []),
      decidedBy: question.decision_authority === 'agent' ? 'AGENT' : 'HUMAN',
      sourceAgent: question.source_agent,
      deliveryUnit: question.story_index,
      specRevision: question.spec_revision,
      resolvedAt: question.resolved_at,
    }));
  const answeredDecisionKeys = [...new Set(userDecisions
    .map((decision) => decision.decisionKey)
    .filter((key): key is string => Boolean(key)))];
  const activeQuestions = full.questions
    .filter((question) => relevantToExecution(delegation.storyIndex, question.story_index) && question.status === 'pending')
    .map((question) => ({
      questionId: question.question_id,
      title: question.title,
      question: question.question,
      why: question.why,
      recommendation: question.recommendation,
      recommendationReason: question.recommendation_reason,
      alternatives: parseJson(question.alternatives_json, []),
      activation: parseJson(question.activation_json, []),
      decidedBy: question.decision_authority === 'agent' ? 'AGENT' : 'HUMAN',
      sourceAgent: question.source_agent,
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
  const activeGroups = full.feedbackGroups.filter((group) =>
    group.group_id === delegation.feedbackGroupId
    || (delegation.storyIndex != null && group.delivery_unit_indexes?.includes(delegation.storyIndex)));
  const groupByComment = new Map<string, FeedbackGroup>();
  for (const group of full.feedbackGroups) {
    for (const commentId of group.comment_ids || []) groupByComment.set(commentId, group);
  }
  const groupCommentIds = new Set(activeGroups.flatMap((group) => group.comment_ids || []));
  const activeFeedback = full.documentComments.filter((comment) =>
    feedbackBatchIds.has(comment.comment_id)
    || groupCommentIds.has(comment.comment_id)
    || input.activeFeedback.some((active) => active.comment_id === comment.comment_id));

  const allResources: AgentContextResource[] = [];
  for (const document of full.documents) {
    allResources.push({
      ref: `DOC:${document.document_id}`,
      kind: 'document',
      title: document.title,
      scope: scope(document.story_index),
      deliveryUnit: document.story_index,
      revision: document.revision,
      status: 'active',
      authority: ['context', 'delivery_split'].includes(document.kind)
        ? 'authoritative'
        : document.kind === 'analysis'
          ? 'supporting'
          : 'execution_evidence',
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
  for (const spec of full.deliverySpecs) {
    allResources.push({
      ref: `SPEC:${spec.spec_id}:r${spec.revision}`,
      kind: 'delivery_spec',
      title: `交付单元 ${spec.story_index} 交付规格 r${spec.revision}`,
      scope: scope(spec.story_index),
      deliveryUnit: spec.story_index,
      revision: spec.revision,
      status: spec.status,
      authority: spec.status === 'resolved' ? 'authoritative' : spec.status === 'superseded' ? 'historical' : 'supporting',
      updatedAt: spec.resolved_at || spec.created_at,
      summary: compact(parseJson(spec.spec_json)),
      content: deliverySpecValue(spec, delegation.agent),
    });
  }
  for (const question of projectedQuestions) {
    const hasActiveAnswer = ['answered', 'resolved'].includes(question.status) && Boolean(question.answer);
    const value = {
      questionId: question.question_id,
      decisionKey: question.decision_key,
      title: question.title,
      question: question.question,
      answer: hasActiveAnswer ? question.answer : null,
      why: question.why,
      recommendation: question.recommendation,
      alternatives: parseJson(question.alternatives_json, []),
      deliveryUnit: question.story_index,
      status: question.status,
      specRevision: question.spec_revision,
      selectedOptionId: hasActiveAnswer ? question.selected_option_id : null,
      activation: parseJson(question.activation_json, []),
    };
    allResources.push({
      ref: `DECISION:${question.question_id}`,
      kind: 'decision',
      title: question.title,
      scope: scope(question.story_index),
      deliveryUnit: question.story_index,
      revision: question.spec_revision,
      status: question.status,
      authority: hasActiveAnswer ? 'authoritative' : 'supporting',
      updatedAt: question.updated_at,
      summary: compact(hasActiveAnswer ? `${question.question} 答复：${question.answer}` : question.question),
      content: value,
    });
  }
  for (const runtimeInput of full.runtimeInputs) {
    const value = runtimeInputValue(runtimeInput);
    allResources.push({
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
    const group = groupByComment.get(comment.comment_id);
    const value = feedbackPromptValue(comment, group);
    const commentStoryIndex = group?.delivery_unit_indexes?.[0]
      ?? full.documents.find((document) => document.document_id === comment.document_id)?.story_index
      ?? null;
    allResources.push({
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
    allResources.push({
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
    const value = recoveryItemForPrompt(recovery, {
      includeResolution: delegation.agent !== 'test-agent',
    });
    allResources.push({
      ref: `RECOVERY:${recovery.recovery_id}`,
      kind: 'recovery',
      title: `${recovery.recovery_id} · ${recovery.summary}`,
      scope: scope(recovery.story_index),
      deliveryUnit: recovery.story_index,
      revision: recovery.failure_count,
      status: delegation.agent === 'test-agent' ? 'pending_verification' : recovery.status,
      authority: ['pending', 'claimed', 'reopened'].includes(recovery.status) ? 'active_obligation' : 'historical',
      updatedAt: delegation.agent === 'test-agent' ? recovery.created_at : recovery.updated_at,
      summary: compact(recovery.summary),
      content: value,
    });
  }
  const resources = allResources.filter((resource) =>
    resourceVisibleToAgent(resource, delegation.agent, delegation.storyIndex));

  const required = new Set<string>();
  if (currentSpec) required.add(`SPEC:${currentSpec.spec_id}:r${currentSpec.revision}`);
  if (delegation.agent === 'analyst-agent' && currentStory) {
    for (const dependencyIndex of currentStory.depends_on_story_indexes) {
      const dependencySpec = latestBy(
        full.deliverySpecs.filter((spec) =>
          spec.story_index === dependencyIndex && spec.status === 'resolved'),
        (spec) => spec.revision,
      );
      if (dependencySpec) {
        required.add(`SPEC:${dependencySpec.spec_id}:r${dependencySpec.revision}`);
      }
    }
  }
  if (delegation.agent === 'review-agent') {
    for (const story of full.stories) {
      const latest = latestBy(
        full.deliverySpecs.filter((spec) => spec.story_index === story.story_index && spec.status !== 'superseded'),
        (spec) => spec.revision,
      );
      if (latest) required.add(`SPEC:${latest.spec_id}:r${latest.revision}`);
    }
  }
  if (delegation.agent === 'feedback-agent') {
    const affectedUnits = new Set(activeFeedback.flatMap((comment) => {
      const group = groupByComment.get(comment.comment_id);
      return group
        ? [
            ...(parseJson(group.affected_story_indexes_json, []) as number[]),
            ...(group.delivery_unit_indexes || []),
          ]
        : [full.documents.find((document) => document.document_id === comment.document_id)?.story_index || null];
    }).filter((value): value is number => Boolean(value)));
    for (const storyIndex of affectedUnits) {
      const latest = latestBy(
        full.deliverySpecs.filter((spec) => spec.story_index === storyIndex && spec.status !== 'superseded'),
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

  const visibleRefs = new Set(resources.map((resource) => resource.ref));
  const visibleRequired = new Set([...required].filter((ref) => visibleRefs.has(ref)));
  const relevantResources = resources.filter((resource) =>
    visibleRequired.has(resource.ref)
    || relevantToExecution(delegation.storyIndex, resource.deliveryUnit));
  const startupIndex = [...relevantResources]
    .sort((left, right) => Number(visibleRequired.has(right.ref)) - Number(visibleRequired.has(left.ref)) || (right.updatedAt || '').localeCompare(left.updatedAt || ''))
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
      currentDeliveryUnit: currentStory ? deliveryUnitContextValue(currentStory) : null,
      deliveryUnits: full.stories.map(deliveryUnitContextValue),
      currentDeliverySpec: currentSpec ? deliverySpecValue(currentSpec, delegation.agent) : null,
      answeredDecisionKeys,
      userDecisions,
      requirementContextResume: delegation.agent === 'backlog-agent' && delegation.pipeline === 'resume'
        ? {
          phase: 'decision_resolution',
          objective: '消费当前有效决策树，在不读取废弃分支的前提下完成决策收敛并进入 TO-BE。',
          businessContext: requirementBaseline(latestBy(
            full.documents.filter((document) => document.kind === 'context' && document.source_agent === 'backlog-agent'),
            (document) => document.revision,
          )?.content),
          activeDecisionTree: userDecisions.filter((decision) =>
            decision.deliveryUnit == null && decision.sourceAgent === 'backlog-agent'),
          activePending: activeQuestions.filter((question) =>
            question.deliveryUnit == null && question.sourceAgent === 'backlog-agent'),
          next: activeQuestions.some((question) =>
            question.deliveryUnit == null && question.sourceAgent === 'backlog-agent')
            ? '继续收敛当前活动决策'
            : 'requirement-context decision-resolution complete',
        }
        : null,
    },
    activeObligations: {
      questions: activeQuestions,
      runtimeInputs: activeRuntimeInputs,
      feedback: activeFeedback.map((comment) => feedbackPromptValue(comment, groupByComment.get(comment.comment_id))),
      recovery: input.activeRecovery.map((recovery) => recoveryItemForPrompt(recovery, {
        includeResolution: delegation.agent !== 'test-agent',
      })),
    },
    recentExecutionEvidence: recentExecutionEvidence(
      delegation.agent,
      delegation.storyIndex,
      full.executionAttempts,
    ),
    requiredContextRefs: [...visibleRequired],
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

function appendJsonSection(lines: string[], title: string, value: unknown) {
  lines.push('', `## ${title}`, '', '```json', JSON.stringify(value, null, 2), '```');
}

function appendRequirementDescription(lines: string[], description: string | null) {
  if (!description) return;
  lines.push('- Description:');
  for (const row of description.split(/\r?\n/)) lines.push(`  > ${row || ' '}`);
}

function nonEmptyObligations(snapshot: AgentContextSnapshot) {
  const obligations = Object.fromEntries(Object.entries(snapshot.activeObligations)
    .filter(([key, value]) => {
      if (!Array.isArray(value) || value.length === 0) return false;
      return !(key === 'questions'
        && snapshot.work.agent === 'backlog-agent'
        && snapshot.authoritativeFacts.requirementContextResume);
    }));
  return Object.keys(obligations).length ? obligations : null;
}

/**
 * Render only the hot, role-relevant projection that belongs in the launch Prompt.
 * The complete immutable snapshot remains available through agent-context commands.
 */
export function renderAgentWorkingContextPack(snapshot: AgentContextSnapshot) {
  const { work, authoritativeFacts } = snapshot;
  const lines = [
    '下面是从完整冻结快照中按当前角色与阶段投影的即时上下文。未内联的资料仍保留在 Context Snapshot 中，可通过 agent-context 命令按需读取。',
    '',
    '## Current Work',
    '',
    `- Task: \`${work.taskId}\``,
    `- Objective: ${work.objective}`,
  ];
  if (work.deliveryUnit != null) lines.push(`- Delivery Unit: ${work.deliveryUnit}`);
  if (work.repositoryBaseCommit) lines.push(`- Repository Base Commit: \`${work.repositoryBaseCommit}\``);

  const requirement = authoritativeFacts.requirement;
  lines.push('', '## Requirement Input', '', `- Title: ${requirement.title}`);
  appendRequirementDescription(lines, requirement.description);
  lines.push(`- Reported Type: ${requirement.itemType}`);
  if (requirement.priority) lines.push(`- Priority: ${requirement.priority}`);
  if (requirement.link) lines.push(`- Supporting Link: ${requirement.link}`);

  if (work.agent === 'backlog-agent') {
    if (authoritativeFacts.requirementContextResume) {
      appendJsonSection(lines, 'Resumed Requirement Context', authoritativeFacts.requirementContextResume);
    } else {
      lines.push(
        '',
        '## Requirement-Context State',
        '',
        '当前没有需要直接内联的恢复决策包。已有草稿、当前阶段和下一工作包以 requirement-context status 的返回为准。',
      );
    }
  } else {
    const relevantFacts: Record<string, unknown> = {};
    if (['analyst-agent', 'dev-agent', 'test-agent', 'feedback-agent'].includes(work.agent)
      && authoritativeFacts.currentDeliveryUnit) {
      relevantFacts.currentDeliveryUnit = authoritativeFacts.currentDeliveryUnit;
    }
    if (['analyst-agent', 'dev-agent', 'test-agent', 'feedback-agent'].includes(work.agent)
      && authoritativeFacts.currentDeliverySpec) {
      relevantFacts.currentDeliverySpec = authoritativeFacts.currentDeliverySpec;
    }
    if (['story-splitter-agent', 'review-agent', 'feedback-agent'].includes(work.agent)
      && authoritativeFacts.deliveryUnits.length) {
      relevantFacts.deliveryUnits = authoritativeFacts.deliveryUnits;
    }
    if (['story-splitter-agent', 'analyst-agent', 'repro-agent', 'review-agent', 'feedback-agent'].includes(work.agent)
      && authoritativeFacts.userDecisions.length) {
      relevantFacts.confirmedDecisions = authoritativeFacts.userDecisions;
    }
    if (['business-design-agent', 'requirement-spec-agent', 'spec-review-agent'].includes(work.agent)
      && authoritativeFacts.userDecisions.length) {
      relevantFacts.confirmedBusinessDecisions = authoritativeFacts.userDecisions;
    }
    if (Object.keys(relevantFacts).length) appendJsonSection(lines, 'Relevant Authoritative Facts', relevantFacts);
  }

  const obligations = nonEmptyObligations(snapshot);
  if (obligations) appendJsonSection(lines, 'Active Obligations', obligations);
  if (snapshot.recentExecutionEvidence.length) {
    appendJsonSection(lines, 'Recent Execution Evidence', snapshot.recentExecutionEvidence);
  }
  return lines.join('\n');
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
    '# Recent Execution Evidence',
    JSON.stringify(snapshot.recentExecutionEvidence, null, 2),
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
