import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, dirname, join, relative, resolve } from 'node:path';
import { Umzug } from 'umzug';

const repositoryRoot = process.cwd();
const isTestProcess = process.env.LOOP_TEST === '1'
  || Boolean(process.env.NODE_TEST_CONTEXT)
  || process.argv.some((argument) => /(?:^|[/\\])[^/\\]+\.test\.[cm]?[jt]sx?$/.test(argument));
const appRoot = process.env.LOOP_APP_ROOT ? resolve(process.env.LOOP_APP_ROOT) : repositoryRoot;
const dataRoot = process.env.LOOP_DATA_ROOT ? resolve(process.env.LOOP_DATA_ROOT) : join(appRoot, 'data');
if (isTestProcess) {
  if (process.env.LOOP_TEST_SETUP_PID !== String(process.pid) || !process.env.LOOP_DATA_ROOT || !process.env.LOOP_WORKSPACE_ROOT_OVERRIDE) {
    throw new Error('数据库测试隔离未初始化；请通过 npm test 运行测试');
  }
  const relation = relative(repositoryRoot, dataRoot);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw new Error(`数据库测试禁止使用仓库内数据路径：${dataRoot}`);
  }
}
const appDbPath = join(dataRoot, 'loopwork.db');
let appDb: Database.Database | undefined;
const workspaceDatabases = new Map<string, Database.Database>();
const workspaceMigrations = new Map<string, Promise<Database.Database>>();

function migrateAppDatabase(database: Database.Database) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const directory = join(appRoot, 'app-migrations');
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.sql')).sort()) {
    const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
    if (applied) continue;
    database.transaction(() => {
      database.exec(readFileSync(join(directory, name), 'utf8'));
      database.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
    })();
  }
}

export function appDatabaseConnection() {
  if (!appDb) {
    mkdirSync(dataRoot, { recursive: true });
    appDb = new Database(appDbPath);
    migrateAppDatabase(appDb);
    const existing = appDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'workspace_root'").get();
    if (!existing) {
      const initialRoot = resolve(process.env.LOOP_WORKSPACE_ROOT || appRoot);
      appDb.prepare("INSERT INTO app_settings(setting_key, setting_value) VALUES('workspace_root', ?)").run(initialRoot);
    }
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

function workspacePaths() {
  const root = getConfiguredWorkspaceRoot();
  const repoHash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const dataDir = join(dataRoot, repoHash);
  return { root, repoHash, dataDir, dbPath: join(dataDir, 'loop-ui.db'), runsDir: join(dataDir, 'runs') };
}

function getWorkspaceDatabase(dbPath: string) {
  let database = workspaceDatabases.get(dbPath);
  if (!database) {
    mkdirSync(dirname(dbPath), { recursive: true });
    database = new Database(dbPath);
    database.exec('PRAGMA foreign_keys = ON');
    workspaceDatabases.set(dbPath, database);
  }
  return database;
}

export async function migrateDatabase() {
  const current = workspacePaths();
  const cached = workspaceMigrations.get(current.dbPath);
  if (cached) return cached;
  const migration = (async () => {
    const database = getWorkspaceDatabase(current.dbPath);
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const migrator = new Umzug({
      migrations: {
        glob: ['*.sql', { cwd: join(appRoot, 'migrations') }],
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
    return database;
  })();
  workspaceMigrations.set(current.dbPath, migration);
  try { return await migration; }
  catch (error) {
    workspaceMigrations.delete(current.dbPath);
    throw error;
  }
}

export async function databaseConnection() { return migrateDatabase(); }

export const paths = {
  appRoot,
  dataRoot,
  appDbPath,
  get root() { return workspacePaths().root; },
  get repoHash() { return workspacePaths().repoHash; },
  get dataDir() { return workspacePaths().dataDir; },
  get dbPath() { return workspacePaths().dbPath; },
  get runsDir() { return workspacePaths().runsDir; },
};

export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
