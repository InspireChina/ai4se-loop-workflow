import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Umzug } from 'umzug';

const appRoot = process.env.LOOP_APP_ROOT ? resolve(process.env.LOOP_APP_ROOT) : process.cwd();
const root = process.env.LOOP_WORKSPACE_ROOT ? resolve(process.env.LOOP_WORKSPACE_ROOT) : appRoot;
const repoHash = createHash('sha1').update(root).digest('hex').slice(0, 12);
const dataRoot = join(appRoot, 'data');
const dataDir = join(dataRoot, repoHash);
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
}

export async function databaseConnection() { return migrateDatabase(); }
export const paths = {
  appRoot,
  root,
  dataRoot,
  dataDir,
  repoHash,
  dbPath,
  inboxPath: join(dataDir, 'inbox.md'),
  controlPath: join(dataDir, 'control.md'),
  runsDir: join(dataDir, 'runs'),
  blocksDir: join(dataDir, 'blocks'),
};
export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
