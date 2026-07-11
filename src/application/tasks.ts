import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { databaseConnection, paths } from '../infrastructure/database';

export type Task = {
  task_id: string; title: string; item_type: string; priority: string | null; agile_status: string;
  current_subagent: string | null; analysis_index: number; dev_index: number; test_index: number;
  total_stories: number; next_step: string | null; work_dir: string; blocked_reason: string | null; updated_at: string;
};

export async function listTasks(): Promise<Task[]> {
  const db = await databaseConnection();
  return db.prepare('SELECT * FROM tasks ORDER BY CASE agile_status WHEN \'blocked\' THEN 0 ELSE 1 END, priority, updated_at DESC').all() as Task[];
}

export async function getTask(taskId: string) {
  const db = await databaseConnection();
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Task | undefined;
  if (!task) return null;
  const stories = db.prepare('SELECT * FROM stories WHERE task_id = ? ORDER BY story_index').all(taskId) as { story_index: number; title: string; directory: string }[];
  const questions = db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at').all(taskId) as Question[];
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Event[];
  return { task, stories, questions, events };
}

type Question = { question_id: string; story_index: number | null; title: string; question: string; recommendation: string | null; answer: string | null; status: string; relative_path: string; kind: string };
type Event = { event_id: string; actor: string; event_type: string; summary: string; created_at: string };

const answerSchema = z.object({ taskId: z.string().min(1), questionId: z.string().min(1), answer: z.string().min(1).max(4000) });

export async function answerQuestion(input: unknown) {
  const { taskId, questionId, answer } = answerSchema.parse(input);
  const db = await databaseConnection();
  const question = db.prepare('SELECT * FROM questions WHERE question_id = ? AND task_id = ?').get(questionId, taskId) as Question | undefined;
  if (!question) throw new Error('Question not found');
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Task;
  const filePath = join(paths.root, question.relative_path);
  if (!filePath.startsWith(paths.root)) throw new Error('Invalid artifact path');
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `\n- 用户确认：${answer}\n`, 'utf8');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE questions SET answer = ?, status = \'answered\', updated_at = CURRENT_TIMESTAMP WHERE question_id = ?').run(answer, questionId);
    db.prepare('INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,?,?,?)').run(randomUUID(), taskId, 'human', 'QuestionAnswered', `回答了「${question.title}」。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  revalidatePath(`/tasks/${taskId}`); revalidatePath('/');
  return task;
}

export async function releaseBlock(taskId: string) {
  const db = await databaseConnection();
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Task | undefined;
  if (!task || task.agile_status !== 'blocked') throw new Error('Task is not blocked');
  const open = (db.prepare('SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = \'pending\'').get(taskId) as { count: number }).count;
  if (open) throw new Error('仍有待回答问题，不能解除阻塞');
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE tasks SET agile_status = 'ready for dev', blocked_reason = NULL, next_step = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(`阻塞已解除，交回 ${task.current_subagent} 继续处理`, taskId);
    db.prepare('INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,?,?,?)').run(randomUUID(), taskId, 'human', 'BlockReleased', `解除阻塞，交回 ${task.current_subagent}。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  revalidatePath(`/tasks/${taskId}`); revalidatePath('/');
}

export async function readQuestionArtifact(relativePath: string) {
  const fullPath = join(paths.root, relativePath);
  if (!fullPath.startsWith(paths.root)) return '';
  try { return await readFile(fullPath, 'utf8'); } catch { return ''; }
}
