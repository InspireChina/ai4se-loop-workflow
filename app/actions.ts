'use server';

import { redirect } from 'next/navigation';
import {
  addQuestion,
  addStory,
  answerQuestion,
  beginRun,
  cancelTask,
  createLoopDispatch,
  endRun,
  createTask,
  initializeTaskContext,
  releaseBlock,
  rewindTask,
  transitionTask,
} from '../src/application/tasks';

export async function createTaskAction(formData: FormData) {
  const taskId = await createTask({
    title: formData.get('title'),
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

export async function startLoopRunAction() {
  const leaseId = await beginRun('ui', 120);
  await createLoopDispatch(leaseId);
  redirect('/');
}

export async function endLoopRunAction(formData: FormData) {
  await endRun(String(formData.get('leaseId')), formData.get('force') === 'on');
  redirect('/');
}

export async function answerQuestionAction(formData: FormData) {
  await answerQuestion({ taskId: formData.get('taskId'), questionId: formData.get('questionId'), answer: formData.get('answer') });
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function releaseBlockAction(formData: FormData) {
  await releaseBlock(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}
