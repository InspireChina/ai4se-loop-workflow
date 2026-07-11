'use server';

import { redirect } from 'next/navigation';
import { answerQuestion, releaseBlock } from '../src/application/tasks';

export async function answerQuestionAction(formData: FormData) {
  await answerQuestion({ taskId: formData.get('taskId'), questionId: formData.get('questionId'), answer: formData.get('answer') });
  redirect(`/tasks/${formData.get('taskId')}`);
}

export async function releaseBlockAction(formData: FormData) {
  await releaseBlock(String(formData.get('taskId')));
  redirect(`/tasks/${formData.get('taskId')}`);
}
