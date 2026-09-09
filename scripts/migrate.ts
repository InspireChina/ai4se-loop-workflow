import './load-env.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run db:migrate -- [--data-root PATH] [--workspace-root PATH] [--legacy-db PATH] [--global-db PATH]');
  process.exit(0);
}

const dataRoot = option('--data-root');
const workspaceRoot = option('--workspace-root');
const legacyDbPath = option('--legacy-db');
const globalDbPath = option('--global-db');
if (dataRoot) process.env.LOOP_DATA_ROOT = dataRoot;
if (workspaceRoot) process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = workspaceRoot;
if (legacyDbPath) process.env.LOOP_LEGACY_DB_PATH = legacyDbPath;
if (globalDbPath) process.env.LOOP_GLOBAL_DB_PATH = globalDbPath;

const { migrateDatabase, paths } = await import('../src/infrastructure/database.js');
const { discoverLegacyProjectDatabases } = await import('../src/infrastructure/legacy-database-import.js');
const db = await migrateDatabase();
const projects = db.prepare(`
  SELECT project_id, name, workspace_root, is_default FROM projects
  WHERE deleted_at IS NULL
  ORDER BY is_default DESC, created_at
`).all();
const importsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_project_database_imports'").get();
const imports = importsTable
  ? db.prepare('SELECT source_db_path, workspace_root, project_id, imported_at FROM legacy_project_database_imports ORDER BY imported_at').all()
  : [];
const importedPaths = new Set((imports as { source_db_path: string }[]).map((item) => item.source_db_path));
const discoveredLegacyDatabases = discoverLegacyProjectDatabases(paths.dataRoot);
const pendingLegacyDatabases = discoveredLegacyDatabases.filter((path) => !importedPaths.has(path));
console.log(JSON.stringify({
  globalDatabase: paths.dbPath,
  selectedLegacyDatabase: legacyDbPath || paths.legacyDbPath,
  projects,
  imports,
  discoveredLegacyDatabases,
  pendingLegacyDatabases,
  nextStep: pendingLegacyDatabases.length
    ? '逐个使用 --legacy-db <DB_PATH> --workspace-root <PROJECT_ROOT> 导入；源库保持只读，重复执行不会重复导入。'
    : null,
}, null, 2));
