import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { databaseConnection, paths } from './database';
import { documentFilesRoot, setDocumentFilesRoot } from './document-files';
import { listDecisionTreeFiles } from './decision-tree-files';
import { addQuestion, answerQuestion, createTask, getTask } from '../application/tasks';

test('complete decision trees are readable JSON and SQL only retains state and signed field references', async () => {
  const taskId = await createTask({ title: 'File decision tree' });
  const db = await databaseConnection();
  db.pragma('recursive_triggers = ON');
  const raw = new Database(paths.dbPath, { readonly: true });
  const originalRoot = documentFilesRoot();
  try {
    const parent = await addQuestion({ taskId, actor: 'backlog-agent', title: 'Choose audience', question: 'Who may export?', decisionKey: 'audience',
      alternatives: [{ id: 'admin', label: 'Administrators', consequences: ['Only admins export'] }, { id: 'all', label: 'Everyone' }] });
    const child = await addQuestion({ taskId, actor: 'backlog-agent', title: 'Choose delivery', question: 'How is the export delivered?', decisionKey: 'delivery',
      dependsOn: ['audience'], activation: [{ decisionKey: 'audience', optionId: 'admin' }], initialStatus: 'conditional',
      alternatives: [{ id: 'download', label: 'Download' }, { id: 'mail', label: 'Email' }] });
    const current = () => listDecisionTreeFiles(db, taskId).find(file => file.kind === 'questions')!;
    const before = current();
    const original = readFileSync(before.path, 'utf8');
    const tree = JSON.parse(original);
    assert.equal(tree.format, 'loopwork-decision-tree');
    assert.equal(tree.taskId, taskId);
    assert.equal(tree.nodes.length, 2);
    assert.deepEqual(tree.nodes.find((node: any) => node.id === child).activation, [{ decisionKey: 'audience', optionId: 'admin' }]);
    assert.equal(tree.nodes.find((node: any) => node.id === parent).options[0].label, 'Administrators');
    const stored = raw.prepare('SELECT title,question,answer,alternatives_json,depends_on_json,status FROM questions WHERE task_id=?').all(taskId) as Record<string, string>[];
    for (const row of stored) {
      for (const field of ['title', 'question', 'alternatives_json', 'depends_on_json']) {
        if (row[field] === null || row[field] === '') continue;
        const ref = JSON.parse(row[field]);
        assert.equal(ref.path, before.path);
        assert.ok(ref.node && ref.field && ref.mac);
      }
      assert.ok(['pending', 'conditional'].includes(row.status));
    }
    assert.equal((await getTask(taskId))?.questions.find(q => q.question_id === parent)?.title, 'Choose audience');
    assert.equal(db.prepare('SELECT json_array_length(alternatives_json) FROM questions WHERE question_id=?').pluck().get(parent), 2);
    const titleReference = stored[0].title;
    const forged = JSON.stringify({ ...JSON.parse(titleReference), field: 'answer' });
    assert.equal(db.prepare('SELECT ? AS value').pluck().get(forged), forged);

    assert.throws(() => db.transaction(() => {
      db.prepare("UPDATE questions SET answer='Uncommitted choice',status='answered' WHERE question_id=?").run(parent);
      throw new Error('rollback');
    })(), /rollback/);
    assert.equal(current().path, before.path);
    assert.equal(readFileSync(before.path, 'utf8'), original);
    assert.equal((await getTask(taskId))?.questions.find(q => q.question_id === parent)?.status, 'pending');
    await answerQuestion({ taskId, questionId: parent, selectedOptionId: 'admin', answer: '' });
    const answered = JSON.parse(readFileSync(current().path, 'utf8'));
    assert.equal(answered.nodes.find((node: any) => node.id === parent).answer, 'Administrators');
    assert.equal(answered.nodes.find((node: any) => node.id === parent).selectedOptionId, 'admin');
    assert.equal(answered.nodes.find((node: any) => node.id === child).status, 'pending');
    assert.equal(readFileSync(before.path, 'utf8'), original);
    const nextRoot = setDocumentFilesRoot(mkdtempSync(join(process.env.LOOP_DATA_ROOT!, 'decisions-')));
    await answerQuestion({ taskId, questionId: child, selectedOptionId: 'download', answer: '' });
    assert.ok(current().path.startsWith(nextRoot));
    assert.equal((await getTask(taskId))?.questions.find(q => q.question_id === child)?.answer, 'Download');
    db.prepare('DELETE FROM questions WHERE question_id=?').run(child);
    assert.equal(JSON.parse(readFileSync(current().path, 'utf8')).nodes.length, 1);
    db.prepare('DELETE FROM questions WHERE question_id=?').run(parent);
    assert.equal(listDecisionTreeFiles(db, taskId).length, 0);
    assert.equal(readFileSync(before.path, 'utf8'), original);
    await addQuestion({ taskId, title: 'Cascade cleanup', question: 'Retain only file history?' });
    db.prepare('DELETE FROM tasks WHERE task_id=?').run(taskId);
    assert.equal(listDecisionTreeFiles(db, taskId).length, 0);

  } finally { raw.close(); setDocumentFilesRoot(originalRoot); }
});
