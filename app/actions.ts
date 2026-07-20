'use server';

import { redirect } from 'next/navigation';
import { normalizeWorkspaceRoot, setAgentExecutorSettings, setLangfuseSettings, setWorkspaceRoot } from '../src/application/project-settings';
import { rollbackAgentPrompt, saveAgentMemory, saveAgentPrompt, setAgentAutoEvolution } from '../src/application/agent-profiles';
import { setSoftwareMaintenanceSettings } from '../src/application/software-maintenance';
import {
  addDocumentComment,
  addStory,
  acknowledgeClosure,
  answerQuestion,
  answerRuntimeInput,
  beginRun,
  cancelTask,
  createLoopDispatch,
  endRun,
  createTask,
  getRunStatus,
  initializeTaskContext,
  releaseBlock,
  resolveDocumentComment,
  submitClarificationAnswers,
  submitRuntimeInputs,
  rewindTask,
  transitionTask,
} from '../src/application/tasks';
import { startAgentRun, startDispatchRetryRun } from '../src/infrastructure/agent-runner';
import { paths } from '../src/infrastructure/database';

export async function createTaskAction(formData: FormData) {
  const taskId = await createTask({
    title: formData.get('title'),
    description: formData.get('description') || undefined,
    link: formData.get('link'),
    itemType: formData.get('itemType') || 'feature',
    priority: formData.get('priority'),
    externalId: formData.get('externalId'),
    externalStatus: formData.get('externalStatus'),
  });
  redirect(`/tasks/${taskId}`);
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
    confirmCodeClean: formData.get('confirmCodeClean') === 'on',
  });
  redirect('/tasks');
}

export async function startLoopRunAction(formData?: FormData) {
  const runId = await beginRun('agent-runner');
  const redirectTo = String(formData?.get('redirectTo') || '/');
  try {
    const dispatch = await createLoopDispatch(runId);
    if (!dispatch.delegations.length) await startDispatchRetryRun(runId);
    else await startAgentRun(runId);
  } catch (error) {
    await endRun(runId, true);
    throw error;
  }
  redirect(redirectTo);
}

export async function saveAgentExecutorAction(formData: FormData) {
  await setAgentExecutorSettings({
    executorId: formData.get('agentExecutor'),
    codexModel: formData.get('codexModel'),
    codexReasoningEffort: formData.get('codexReasoningEffort'),
  });
  redirect('/settings');
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

export async function endLoopRunAction(formData: FormData) {
  await endRun(String(formData.get('runId')), formData.get('force') === 'on');
  redirect(String(formData.get('redirectTo') || '/'));
}

export async function answerQuestionAction(formData: FormData) {
  await answerQuestion({ taskId: formData.get('taskId'), questionId: formData.get('questionId'), answer: formData.get('answer') });
  redirect(`/tasks/${formData.get('taskId')}`);
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
  });
  redirect(`/tasks/${taskId}`);
}

export async function resolveDocumentCommentAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await resolveDocumentComment({ taskId, commentId: formData.get('commentId') });
  redirect(`/tasks/${taskId}`);
}

export async function releaseBlockAction(formData: FormData) {
  await releaseBlock(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function submitClarificationAnswersAction(formData: FormData) {
  await submitClarificationAnswers(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function submitRuntimeInputsAction(formData: FormData) {
  await submitRuntimeInputs(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function acknowledgeClosureAction(formData: FormData) {
  await acknowledgeClosure({
    taskId: formData.get('taskId'),
    reviewRevision: formData.get('reviewRevision'),
  });
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function saveAgentPromptAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await saveAgentPrompt({ agentId, content: formData.get('content'), reason: formData.get('reason') });
  redirect(`/agents/${agentId}`);
}

export async function saveAgentMemoryAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await saveAgentMemory({ agentId, content: formData.get('content'), reason: formData.get('reason') });
  redirect(`/agents/${agentId}`);
}

export async function setAgentAutoEvolutionAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await setAgentAutoEvolution({ agentId, enabled: formData.get('enabled') });
  redirect(`/agents/${agentId}`);
}

export async function rollbackAgentPromptAction(formData: FormData) {
  const agentId = String(formData.get('agentId'));
  await rollbackAgentPrompt({ agentId, version: formData.get('version') });
  redirect(`/agents/${agentId}`);
}

export async function saveSoftwareMaintenanceSettingsAction(formData: FormData) {
  await setSoftwareMaintenanceSettings({
    enabled: formData.get('softwareMaintenanceEnabled'),
    autoApply: formData.get('softwareMaintenanceAutoApply'),
  });
  redirect('/maintenance');
}
