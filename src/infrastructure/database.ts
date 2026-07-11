import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Umzug } from 'umzug';

const root = process.env.LOOP_WORKSPACE_ROOT ? resolve(process.env.LOOP_WORKSPACE_ROOT) : process.cwd();
const dataDir = join(root, '.project', '_loop');
const dbPath = join(dataDir, 'loop-ui.db');
let db: Database.Database | undefined;

function getDb() {
  if (!db) {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

export async function migrateDatabase() {
  const database = getDb();
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const migrator = new Umzug({
    migrations: {
      glob: ['*.sql', { cwd: join(root, 'migrations') }],
      resolve: ({ name, path }) => ({ name, up: async () => {
        for (const statement of readFileSync(path!, 'utf8').split(';').map((item) => item.trim()).filter(Boolean)) {
          try { database.exec(statement); }
          catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (!message.includes('duplicate column name') && !message.includes('already exists')) throw error;
          }
        }
      } }),
    },
    context: database,
    storage: {
      executed: async () => (database.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]).map((row) => row.name),
      logMigration: async ({ name }) => { database.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name); },
      unlogMigration: async ({ name }) => { database.prepare('DELETE FROM schema_migrations WHERE name = ?').run(name); },
    },
    logger: undefined,
  });
  await migrator.up();
  seedDemo(database);
  return database;
}

function seedDemo(database: Database.Database) {
  const workDir = '.project/features/demo-project-filter';
  const questionPath = `${workDir}/stories/story-002/90_analysis_questions.md`;
  writeArtifact(questionPath, '# 90 Analysis Questions\n\nAnalysis Decision: pending\nClarification Round: 1\n\n## 待确认\n\n### Q-multi-pic：多个 PIC 的筛选语义\n\n- 问题：同时选择多个 PIC 时，列表展示任一 PIC 负责的项目，还是只展示所有 PIC 共同负责的项目？\n- 推荐答案：推荐 OR。\n- 用户确认：\n');
  const count = (database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count;
  if (count) return;
  const taskId = 'TASK-project-filter';
  database.prepare(`INSERT INTO tasks(task_id,title,item_type,priority,agile_status,current_subagent,analysis_index,dev_index,test_index,total_stories,analysis_approved_index,next_step,work_dir,blocked_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, '项目列表支持按 PIC 筛选', 'feature', 'P1', 'blocked', 'analyst-agent', 1, 1, 0, 3, 1, '回答 story-2 的业务问题后解除阻塞', workDir, '等待用户确认 story-2 多选筛选语义');
  const stories = ['单个 PIC 筛选', '多个 PIC 筛选', '清除筛选条件'];
  stories.forEach((title, index) => database.prepare('INSERT INTO stories(task_id,story_index,title,directory) VALUES(?,?,?,?)').run(taskId, index + 1, title, `stories/story-${String(index + 1).padStart(3, '0')}`));
  database.prepare('INSERT INTO questions(question_id,task_id,story_index,kind,title,question,recommendation,relative_path) VALUES(?,?,?,?,?,?,?,?)').run('Q-multi-pic', taskId, 2, 'analysis', '多个 PIC 的筛选语义', '同时选择多个 PIC 时，列表展示任一 PIC 负责的项目，还是只展示所有 PIC 共同负责的项目？', '推荐 OR：符合常见筛选行为，也更容易得到有效结果。', questionPath);
  database.prepare('INSERT INTO approvals(approval_id,task_id,story_index,kind,decision,relative_path) VALUES(?,?,?,?,?,?)').run('APR-analysis-2', taskId, 2, 'analysis', 'pending', questionPath);
  database.prepare('INSERT INTO task_events(event_id,task_id,actor,event_type,summary) VALUES(?,?,?,?,?)').run(randomUUID(), taskId, 'analyst-agent', 'TaskBlocked', '已完成 story-1；等待 story-2 业务确认。');
}

function writeArtifact(relativePath: string, content: string) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  if (!existsSync(full)) writeFileSync(full, content, 'utf8');
}

export async function databaseConnection() { return migrateDatabase(); }
export const paths = { root, dbPath };
export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
