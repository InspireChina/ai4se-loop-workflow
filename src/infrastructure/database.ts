import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, basename, dirname, join, relative, resolve } from 'node:path';
import { Umzug } from 'umzug';
import {
  backupLegacyDatabase,
  importLegacyProjectDatabase,
  legacyProjectDatabasePath,
  mergeLegacyProjectDatabase,
} from './legacy-database-import';

const repositoryRoot = resolve(/* turbopackIgnore: true */ process.cwd());
export function isDatabaseTestProcess(env: Readonly<Record<string, string | undefined>>) {
  return env.LOOP_TEST === '1' || Boolean(env.NODE_TEST_CONTEXT);
}
const isTestProcess = isDatabaseTestProcess(process.env);
const appRoot = process.env.LOOP_APP_ROOT ? resolve(/* turbopackIgnore: true */ process.env.LOOP_APP_ROOT) : repositoryRoot;
const dataRoot = process.env.LOOP_DATA_ROOT ? resolve(/* turbopackIgnore: true */ process.env.LOOP_DATA_ROOT) : join(/* turbopackIgnore: true */ appRoot, 'data');
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
}

export function appDatabaseConnection() {
  if (!appDb) {
    mkdirSync(dataRoot, { recursive: true });
    appDb = new Database(appDbPath);
    appDb.pragma('busy_timeout = 15000');
    appDb.pragma('journal_mode = WAL');
    appDb.pragma('synchronous = NORMAL');
    migrateAppDatabase(appDb);
    appMigrationLastCheckedAt = Date.now();
    const existing = appDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'workspace_root'").get();
    if (!existing) {
      const initialRoot = resolve(process.env.LOOP_WORKSPACE_ROOT || appRoot);
      appDb.prepare("INSERT INTO app_settings(setting_key, setting_value) VALUES('workspace_root', ?)").run(initialRoot);
    }
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
  if (process.env.LOOP_WORKSPACE_ROOT_OVERRIDE) return resolve(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE);
  const row = appDatabaseConnection().prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'workspace_root'").get() as { setting_value: string } | undefined;
  return resolve(row?.setting_value || process.env.LOOP_WORKSPACE_ROOT || appRoot);
}

export function setConfiguredWorkspaceRoot(workspaceRoot: string) {
  const root = resolve(workspaceRoot);
  appDatabaseConnection().prepare(`
    INSERT INTO app_settings(setting_key, setting_value)
    VALUES('workspace_root', ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(root);
  return root;
}

function getBusinessDatabase(dbPath: string) {
  let database = businessDatabases.get(dbPath);
  if (!database) {
    mkdirSync(dirname(dbPath), { recursive: true });
    database = new Database(dbPath);
    database.pragma('busy_timeout = 15000');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.exec('PRAGMA foreign_keys = ON');
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
    const existing = database.prepare('SELECT project_id, is_default FROM projects ORDER BY is_default DESC, created_at, project_id LIMIT 1')
      .get() as { project_id: string; is_default: number } | undefined;
    const projectId = existing?.project_id || 'PRJ-default';
    if (!existing) {
      database.prepare(`
        INSERT INTO projects(project_id, name, workspace_root, description, is_default)
        VALUES(?, ?, ?, ?, 1)
      `).run(projectId, basename(workspaceRoot) || '默认项目', workspaceRoot, '由原“当前项目”工作区自动迁移');
    } else if (!existing.is_default) {
      database.prepare('UPDATE projects SET is_default = 1 WHERE project_id = ?').run(projectId);
    }
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

export async function migrateDatabase() {
  const cached = businessMigrations.get(globalDbPath);
  if (cached) return cached;
  const migration = (async () => {
    const workspaceRoot = getConfiguredWorkspaceRoot();
    const legacyImport = await importLegacyProjectDatabase({
      dataRoot,
      workspaceRoot,
      globalDbPath,
      legacyDbPath: process.env.LOOP_LEGACY_DB_PATH,
    });
    const database = getBusinessDatabase(globalDbPath);
    const projectId = await migrateBusinessSchema(database, workspaceRoot);
    if (legacyImport.status === 'imported' && projectId) {
      database.prepare(`
        INSERT OR IGNORE INTO legacy_project_database_imports(
          source_db_path, workspace_root, project_id
        ) VALUES(?, ?, ?)
      `).run(legacyImport.sourcePath, workspaceRoot, projectId);
    }
    const explicitLegacyPath = process.env.LOOP_LEGACY_DB_PATH
      ? resolve(process.env.LOOP_LEGACY_DB_PATH)
      : undefined;
    if (explicitLegacyPath && explicitLegacyPath !== globalDbPath && existsSync(explicitLegacyPath)) {
      const imported = database.prepare(`
        SELECT 1 FROM legacy_project_database_imports WHERE source_db_path = ?
      `).get(explicitLegacyPath);
      if (!imported) {
        const temporaryPath = `${globalDbPath}.legacy-merge-${process.pid}.tmp`;
        try {
          await backupLegacyDatabase(explicitLegacyPath, temporaryPath);
          const legacyDatabase = new Database(temporaryPath);
          try {
            legacyDatabase.pragma('foreign_keys = ON');
            legacyDatabase.pragma('busy_timeout = 15000');
            await migrateBusinessSchema(legacyDatabase, workspaceRoot);
          } finally {
            legacyDatabase.close();
          }
          mergeLegacyProjectDatabase({
            target: database,
            sourcePath: explicitLegacyPath,
            databasePath: temporaryPath,
            workspaceRoot,
          });
        } finally {
          rmSync(temporaryPath, { force: true });
          rmSync(`${temporaryPath}-wal`, { force: true });
          rmSync(`${temporaryPath}-shm`, { force: true });
        }
      }
    }
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
  get legacyDbPath() {
    return resolve(process.env.LOOP_LEGACY_DB_PATH || legacyProjectDatabasePath(dataRoot, getConfiguredWorkspaceRoot()));
  },
};

export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
