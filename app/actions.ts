'use server';

import { redirect } from 'next/navigation';
import { normalizeWorkspaceRoot, setAgentExecutorSettings, setAgentRuntimeSettings, setFlowAgentDefaultRuntimeSettings, setLangfuseSettings, setWorkspaceRoot } from '../src/application/project-settings';
import { resetAgentPromptToSystemTemplate, saveAgentMemory, saveAgentPrompt, setAgentAutoEvolution } from '../src/application/agent-profiles';
import {
  addDocumentComment,
  addStory,
  acknowledgeClosure,
  answerQuestion,
  answerRuntimeInput,
  cancelTask,
  createTask,
  getRunStatus,
  initializeTaskContext,
  pauseTask,
  releaseBlock,
  resumeTask,
  reopenDocumentComment,
  setTaskPriority,
  submitClarificationAnswers,
  submitRuntimeInputs,
  rewindTask,
  transitionTask,
} from '../src/application/tasks';
import { paths } from '../src/infrastructure/database';
import { requirementPipeline } from '../src/domain/pipeline-catalog';
import { DEFAULT_REQUIREMENT_PRIORITY, requirementPriority } from '../src/domain/requirement-priority';
import { parseRequirementMetadata } from '../src/domain/requirement-metadata';
import {
  createScheduledRequirement,
  deleteScheduledRequirement,
  pauseScheduledRequirement,
  resumeScheduledRequirement,
  updateScheduledRequirement,
} from '../src/application/scheduled-requirements';

export async function createTaskAction(formData: FormData) {
  const pipeline = requirementPipeline(formData.get('pipeline') || 'feature');
  const priority = requirementPriority(formData.get('priority') || DEFAULT_REQUIREMENT_PRIORITY);
  const metadataKeys = formData.getAll('metadataKey');
  const metadataValues = formData.getAll('metadataValue');
  const metadata = parseRequirementMetadata(metadataKeys.map((key, index) => ({
    key,
    value: metadataValues[index],
  })));
  const taskId = await createTask({
    title: formData.get('title'),
    description: formData.get('description') || undefined,
    itemType: pipeline,
    priority,
    metadata,
  });
  redirect(`/tasks/${taskId}`);
}

function scheduledRequirementInput(formData: FormData) {
  const metadataKeys = formData.getAll('metadataKey');
  const metadataValues = formData.getAll('metadataValue');
  const metadata = parseRequirementMetadata(metadataKeys.map((key, index) => ({
    key,
    value: metadataValues[index],
  })));
  const recurrenceKind = String(formData.get('recurrenceKind') || 'daily');
  return {
    recurrenceKind,
    timezone: formData.get('timezone'),
    localTime: recurrenceKind === 'once' ? undefined : formData.get('localTime'),
    weekday: recurrenceKind === 'weekly' ? formData.get('weekday') : undefined,
    dayOfMonth: recurrenceKind === 'monthly' ? formData.get('dayOfMonth') : undefined,
    onceAtLocal: recurrenceKind === 'once' ? formData.get('onceAtLocal') : undefined,
    title: formData.get('title'),
    description: formData.get('description') || undefined,
    pipeline: formData.get('pipeline'),
    priority: formData.get('priority'),
    metadata,
  };
}

export async function saveScheduledRequirementAction(formData: FormData) {
  const planId = String(formData.get('planId') || '');
  const input = scheduledRequirementInput(formData);
  if (planId) await updateScheduledRequirement({ ...input, planId });
  else await createScheduledRequirement(input);
  redirect('/schedules');
}

export async function pauseScheduledRequirementAction(formData: FormData) {
  await pauseScheduledRequirement(String(formData.get('planId')));
  redirect('/schedules');
}

export async function resumeScheduledRequirementAction(formData: FormData) {
  await resumeScheduledRequirement(String(formData.get('planId')));
  redirect('/schedules');
}

export async function deleteScheduledRequirementAction(formData: FormData) {
  await deleteScheduledRequirement(String(formData.get('planId')));
  redirect('/schedules');
}

export async function updateTaskPriorityAction(taskId: string, priority: string) {
  await setTaskPriority({ taskId, priority });
}

export async function initializeContextAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await initializeTaskContext({
    taskId,
    kind: formData.get('kind') || 'feature',
    slug: formData.get('slug'),
    status: formData.get('status') || undefined,
    currentSubagent: formData.get('currentSubagent') || undefined,
    nextStep: formData.get('nextStep') || undefined,
  });
  redirect(`/tasks/${taskId}`);
}

export async function addStoryAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await addStory({ taskId, title: formData.get('title') });
  redirect(`/tasks/${taskId}`);
}

export async function transitionTaskAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await transitionTask({
    taskId,
    status: formData.get('status'),
    currentSubagent: formData.get('currentSubagent') || undefined,
    nextStep: formData.get('nextStep') || undefined,
  });
  redirect(`/tasks/${taskId}`);
}

export async function rewindTaskAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await rewindTask({
    taskId,
    to: formData.get('to'),
    story: formData.get('story') || undefined,
    reason: formData.get('reason'),
  });
  redirect(`/tasks/${taskId}`);
}

export async function cancelTaskAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await cancelTask({
    taskId,
    reason: formData.get('reason'),
  });
  redirect('/tasks');
}

export async function pauseTaskAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await pauseTask({ taskId, reason: String(formData.get('reason') || '').trim() || undefined });
  redirect(`/tasks/${taskId}`);
}

export async function resumeTaskAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await resumeTask({ taskId });
  redirect(`/tasks/${taskId}`);
}

export async function saveAgentExecutorAction(formData: FormData) {
  await setAgentExecutorSettings({
    executorId: formData.get('agentExecutor'),
    codexModel: formData.get('codexModel'),
    codexReasoningEffort: formData.get('codexReasoningEffort'),
    codexWebSearch: formData.get('codexWebSearch'),
    claudeModel: formData.get('claudeModel'),
    ompModel: formData.get('ompModel'),
    ompThinking: formData.get('ompThinking'),
  });
  redirect('/settings');
}

export async function saveFlowAgentDefaultRuntimeAction(formData: FormData) {
  await setFlowAgentDefaultRuntimeSettings({
    executorId: formData.get('agentExecutor'),
    codexModel: formData.get('codexModel'),
    codexReasoningEffort: formData.get('codexReasoningEffort'),
    codexWebSearch: formData.get('codexWebSearch'),
    claudeModel: formData.get('claudeModel'),
    ompModel: formData.get('ompModel'),
    ompThinking: formData.get('ompThinking'),
  });
  redirect('/settings');
}

function redirectToAgentSection(agentId: string, sectionInput: FormDataEntryValue | null): never {
  const section = String(sectionInput || '');
  const allowedSections = new Set(['runtime', 'prompt', 'memory', 'evolution', 'diagnostics']);
  redirect(`/agents/${agentId}${allowedSections.has(section) ? `?section=${section}` : ''}`);
}

export async function saveAgentRuntimeAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await setAgentRuntimeSettings(agentId, {
    inheritProjectDefault: formData.get('inheritProjectDefault'),
    executorId: formData.get('agentExecutor'),
    codexModel: formData.get('codexModel'),
    codexReasoningEffort: formData.get('codexReasoningEffort'),
    codexWebSearch: formData.get('codexWebSearch'),
    claudeModel: formData.get('claudeModel'),
    ompModel: formData.get('ompModel'),
    ompThinking: formData.get('ompThinking'),
  });
  redirectToAgentSection(agentId, formData.get('section'));
}

export async function saveLangfuseSettingsAction(formData: FormData) {
  await setLangfuseSettings({
    enabled: formData.get('langfuseEnabled'),
    publicKey: formData.get('langfusePublicKey'),
    secretKey: formData.get('langfuseSecretKey'),
    baseUrl: formData.get('langfuseBaseUrl'),
    sampleRate: formData.get('langfuseSampleRate'),
    capturePrompts: formData.get('langfuseCapturePrompts'),
  });
  redirect('/settings');
}

export async function changeWorkspaceRootAction(formData: FormData) {
  const nextRoot = normalizeWorkspaceRoot(formData.get('workspaceRoot'));
  const currentRoot = paths.root;
  if (nextRoot !== currentRoot && (await getRunStatus())?.active) throw new Error('请先结束当前运行，再切换工作区');
  setWorkspaceRoot(nextRoot);
  redirect('/settings');
}

export async function answerQuestionAction(formData: FormData) {
  await answerQuestion({
    taskId: formData.get('taskId'),
    questionId: formData.get('questionId'),
    answer: formData.get('answer') || '',
    selectedOptionId: formData.get('selectedOptionId') || null,
  });
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function answerDecisionQuestionAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await answerQuestion({
    taskId,
    questionId: formData.get('questionId'),
    answer: formData.get('answer') || '',
    selectedOptionId: formData.get('selectedOptionId') || null,
  });
  redirect(`/decisions?taskId=${encodeURIComponent(taskId)}`);
}

export async function answerRuntimeInputAction(formData: FormData) {
  await answerRuntimeInput({
    taskId: formData.get('taskId'),
    requestId: formData.get('requestId'),
    answer: formData.get('answer'),
  });
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function addDocumentCommentAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await addDocumentComment({
    taskId,
    documentId: formData.get('documentId'),
    anchorType: formData.get('anchorType') || 'file',
    quotedText: formData.get('quotedText') || undefined,
    startOffset: formData.get('startOffset') || undefined,
    endOffset: formData.get('endOffset') || undefined,
    content: formData.get('content'),
    intent: formData.get('intent') || 'change_request',
  });
  redirect(`/tasks/${taskId}`);
}

export async function reopenDocumentCommentAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await reopenDocumentComment({ taskId, commentId: formData.get('commentId') });
  redirect(`/tasks/${taskId}`);
}

export async function releaseBlockAction(formData: FormData) {
  const lane = String(formData.get('lane') || '');
  await releaseBlock(String(formData.get('taskId')), lane === 'analysis' || lane === 'delivery' ? lane : undefined);
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function submitClarificationAnswersAction(formData: FormData) {
  await submitClarificationAnswers(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function submitDecisionAnswersAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await submitClarificationAnswers(taskId);
  redirect(`/decisions?taskId=${encodeURIComponent(taskId)}`);
}

export async function submitRuntimeInputsAction(formData: FormData) {
  const lane = String(formData.get('lane') || '');
  await submitRuntimeInputs(String(formData.get('taskId')), lane === 'analysis' || lane === 'delivery' ? lane : undefined);
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function acknowledgeClosureAction(formData: FormData) {
  await acknowledgeClosure({
    taskId: formData.get('taskId'),
    reviewRevision: formData.get('reviewRevision'),
  });
  redirect('/tasks');
}

export async function saveAgentPromptAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await saveAgentPrompt({ agentId, content: formData.get('content'), reason: formData.get('reason') });
  redirectToAgentSection(agentId, formData.get('section'));
}

export async function resetAgentPromptAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  if (formData.get('confirm') !== 'on') throw new Error('请先确认重置当前项目 Prompt');
  await resetAgentPromptToSystemTemplate({ agentId });
  redirectToAgentSection(agentId, formData.get('section'));
}

export async function saveAgentMemoryAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await saveAgentMemory({ agentId, content: formData.get('content'), reason: formData.get('reason') });
  redirectToAgentSection(agentId, formData.get('section'));
}

export async function setAgentAutoEvolutionAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await setAgentAutoEvolution({ agentId, enabled: formData.get('enabled') });
  redirectToAgentSection(agentId, formData.get('section'));
}
