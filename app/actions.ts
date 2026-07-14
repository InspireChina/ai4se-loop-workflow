'use server';

import { redirect } from 'next/navigation';
import { normalizeWorkspaceRoot, setAgentExecutorSettings, setWorkspaceRoot } from '../src/application/project-settings';
import {
  addQuestion,
  addStory,
  answerQuestion,
  beginRun,
  cancelTask,
  createLoopDispatch,
  endRun,
  createTask,
  getRunStatus,
  initializeTaskContext,
  releaseBlock,
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

export async function addQuestionAction(formData: FormData) {
  const taskId = String(formData.get('taskId'));
  await addQuestion({
    taskId,
    storyIndex: formData.get('storyIndex') || undefined,
    kind: formData.get('kind') || 'local',
    title: formData.get('title'),
    question: formData.get('question'),
    why: formData.get('why'),
    recommendation: formData.get('recommendation'),
    blockedReason: formData.get('blockedReason'),
    blockTask: formData.get('blockTask') === 'on',
  });
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
  const dispatch = await createLoopDispatch(runId);
  if (!dispatch.delegations.length) {
    await startDispatchRetryRun(runId);
    redirect(String(formData?.get('redirectTo') || '/'));
  }
  await startAgentRun(runId);
  redirect(String(formData?.get('redirectTo') || '/'));
}

export async function saveAgentExecutorAction(formData: FormData) {
  await setAgentExecutorSettings({
    executorId: formData.get('agentExecutor'),
    codexModel: formData.get('codexModel'),
    codexReasoningEffort: formData.get('codexReasoningEffort'),
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

export async function releaseBlockAction(formData: FormData) {
  await releaseBlock(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}
