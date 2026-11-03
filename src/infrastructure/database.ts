import { attachFilePayloads, installFilePayloadColumns } from './file-payloads';
import { readDocumentBody } from './document-files';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, basename, dirname, join, relative, resolve } from 'node:path';
import { Umzug } from 'umzug';


const repositoryRoot = resolve(/* turbopackIgnore: true */ process.cwd());
export function isDatabaseTestProcess(env: Readonly<Record<string, string | undefined>>) {
  return env.LOOP_TEST === '1' || Boolean(env.NODE_TEST_CONTEXT);
}
const isTestProcess = isDatabaseTestProcess(process.env);
const appRoot = process.env.LOOP_APP_ROOT ? resolve(/* turbopackIgnore: true */ process.env.LOOP_APP_ROOT) : repositoryRoot;
const dataRoot = process.env.LOOP_DATA_ROOT ? resolve(/* turbopackIgnore: true */ process.env.LOOP_DATA_ROOT) : join(/* turbopackIgnore: true */ appRoot, 'data', 'dji');
if (isTestProcess) {
  if (process.env.LOOP_TEST_SETUP_PID !== String(process.pid) || !process.env.LOOP_DATA_ROOT || !process.env.LOOP_WORKSPACE_ROOT_OVERRIDE) {
    throw new Error('数据库测试隔离未初始化；请通过 npm test 运行测试');
  }
  const relation = relative(repositoryRoot, dataRoot);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw new Error(`数据库测试禁止使用仓库内数据路径：${dataRoot}`);
  }
}
const appDbPath = join(/* turbopackIgnore: true */ dataRoot, 'loopwork.db');
const globalDbPath = resolve(/* turbopackIgnore: true */ process.env.LOOP_GLOBAL_DB_PATH || join(dataRoot, 'loop-ui.db'));
let appDb: Database.Database | undefined;
let appMigrationLastCheckedAt = 0;
const businessDatabases = new Map<string, Database.Database>();
const businessMigrations = new Map<string, Promise<Database.Database>>();
function migrateAppDatabase(database: Database.Database) {
  // Seed/configuration content must be externalized before its first commit.
  database.transaction(() => {
    database.pragma('busy_timeout = 15000');
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const directory = join(/* turbopackIgnore: true */ appRoot, 'app-migrations');
    for (const name of readdirSync(directory).filter((item) => item.endsWith('.sql')).sort()) {
      database.transaction(() => {
        const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
        if (applied) return;
        database.exec(readFileSync(join(directory, name), 'utf8'));
        database.prepare('INSERT OR IGNORE INTO schema_migrations(name) VALUES (?)').run(name);
      }).immediate();
    }
    installFilePayloadColumns(database);
  }).immediate();
}

export function appDatabaseConnection() {
  if (!appDb) {
    mkdirSync(dataRoot, { recursive: true });
    appDb = new Database(appDbPath);
    attachFilePayloads(appDb, dataRoot);
    appDb.pragma('busy_timeout = 15000');
    appDb.pragma('journal_mode = WAL');
    appDb.pragma('synchronous = NORMAL');
    migrateAppDatabase(appDb);
    appMigrationLastCheckedAt = Date.now();
  } else if (process.env.NODE_ENV === 'development' && Date.now() - appMigrationLastCheckedAt >= 1_000) {
    // Turbopack can hot-reload callers while retaining this open SQLite connection.
    // Re-scan migrations in development so newly added app migrations do not require
    // business code to query a stale schema before the developer restarts the server.
    migrateAppDatabase(appDb);
    appMigrationLastCheckedAt = Date.now();
  }
  return appDb;
}

export function getConfiguredWorkspaceRoot() {
  const requested = resolve(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE || process.env.LOOP_WORKSPACE_ROOT || process.cwd());
  let root: string;
  try { root = realpathSync(requested); }
  catch { throw new Error(`工作目录不存在：${requested}`); }
  if (!statSync(root).isDirectory()) throw new Error(`工作目录不是文件夹：${root}`);
  return root;
}

function getBusinessDatabase(dbPath: string) {
  let database = businessDatabases.get(dbPath);
  if (!database) {
    mkdirSync(dirname(dbPath), { recursive: true });
    database = new Database(dbPath);
    attachFilePayloads(database, dataRoot);
    database.pragma('busy_timeout = 15000');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.function('loopwork_read_document', (value: unknown) => typeof value === 'string' ? readDocumentBody(value) : value);
    businessDatabases.set(dbPath, database);
  }
  return database;
}

/**
 * SQLite triggers contain semicolons inside BEGIN/END, so a plain split(';')
 * corrupts otherwise valid migrations. Keep trigger bodies intact while still
 * allowing a partially applied ALTER TABLE migration to resume safely.
 */
export function splitSqlMigrationStatements(sql: string) {
  const statements: string[] = [];
  let buffer = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  let trigger = false;

  const push = () => {
    const statement = buffer.trim();
    if (statement) statements.push(statement);
    buffer = '';
    trigger = false;
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    buffer += char;
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        buffer += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && char === '-' && next === '-') {
      buffer += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      buffer += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (quote) {
      if ((quote === ']' && char === ']') || (quote !== ']' && char === quote)) {
        if (quote !== ']' && next === quote) {
          buffer += next;
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '[') quote = ']';
    if (!trigger && /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(buffer)) trigger = true;
    if (char === ';' && (!trigger || /\bEND\s*;\s*$/i.test(buffer))) push();
  }
  push();
  return statements;
}

function executeBusinessMigration(database: Database.Database, sql: string) {
  database.transaction(() => {
    for (const statement of splitSqlMigrationStatements(sql)) {
      try { database.exec(statement); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('duplicate column name') && !message.includes('already exists')) throw error;
      }
    }
  })();
}

async function migrateBusinessSchema(database: Database.Database, workspaceRoot: string) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const migrator = new Umzug({
    migrations: {
      glob: ['*.sql', { cwd: join(/* turbopackIgnore: true */ appRoot, 'migrations') }],
      resolve: ({ name, path }) => ({ name, up: async () => {
        executeBusinessMigration(database, readFileSync(path!, 'utf8'));
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
  database.exec('BEGIN IMMEDIATE');
  try {
    const executed = (database.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[]).map((row) => row.name);
    if (!executed.includes('104_default_project.sql')) await migrator.up({ to: '104_default_project.sql' });
    const projectId = ensureDefaultProject(database, workspaceRoot);
    await migrator.up();
    ensureDefaultProject(database, workspaceRoot);
    installFilePayloadColumns(database);
    database.exec('COMMIT');
    return projectId;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function ensureDefaultProject(database: Database.Database, workspaceRoot: string) {
  const hasProjectsTable = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'
  `).get();
  if (!hasProjectsTable) return null;
  return database.transaction(() => {
    const existing = database.prepare('SELECT project_id, workspace_root FROM projects').all() as { project_id: string; workspace_root: string }[];
    const projectId = 'PRJ-default';
    if (existing.length > 1 || existing.some(row => row.project_id !== projectId)) {
      throw new Error('DJI 仅支持单工作目录，请使用新的 --data-dir；不导入多项目数据');
    }
    if (existing[0]?.workspace_root !== workspaceRoot && existing.length) {
      const count = database.prepare('SELECT COUNT(*) FROM tasks').pluck().get() as number;
      if (count) throw new Error(`数据目录已绑定 ${existing[0].workspace_root}，请为 ${workspaceRoot} 使用独立 --data-dir`);
    }
    database.prepare(`
      INSERT INTO projects(project_id, name, workspace_root, description, is_default)
      VALUES(?, ?, ?, '当前实例唯一工作目录', 1)
      ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, workspace_root=excluded.workspace_root
    `).run(projectId, basename(workspaceRoot) || '工作目录', workspaceRoot);
    database.prepare(`
      UPDATE tasks
      SET project_id = ?, work_dir = CASE WHEN trim(work_dir) = '' THEN ? ELSE work_dir END
      WHERE project_id IS NULL
    `).run(projectId, workspaceRoot);
    database.prepare(`
      UPDATE resource_claims
      SET resource_scope = 'project:' || COALESCE(
        (SELECT task.project_id FROM tasks task WHERE task.task_id = resource_claims.owner_task_id),
        'legacy'
      )
      WHERE resource_key = 'code:workspace'
    `).run();
    return projectId;
  })();
}

function isTemporaryWorkspaceRoot(workspaceRoot: string) {
  const candidate = resolve(workspaceRoot);
  const temporaryRoots = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp'])];
  return temporaryRoots.some((temporaryRoot) => {
    const relation = relative(resolve(temporaryRoot), candidate);
    return !relation || (!relation.startsWith('..') && !isAbsolute(relation));
  });
}

export async function migrateDatabase() {
  const cached = businessMigrations.get(globalDbPath);
  if (cached) return cached;
  const migration = (async () => {
    const workspaceRoot = getConfiguredWorkspaceRoot();
    // DJI starts directly from its state database. Never scan, copy or merge historical projects.
    const database = getBusinessDatabase(globalDbPath);
    await migrateBusinessSchema(database, workspaceRoot);
    return database;
  })();
  businessMigrations.set(globalDbPath, migration);
  try { return await migration; }
  catch (error) {
    businessMigrations.delete(globalDbPath);
    throw error;
  }
}

export async function databaseConnection() { return migrateDatabase(); }

export const paths = {
  appRoot,
  dataRoot,
  appDbPath,
  get root() { return getConfiguredWorkspaceRoot(); },
  dataDir: dataRoot,
  dbPath: globalDbPath,
  runsDir: join(dataRoot, 'runs'),

};

export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
