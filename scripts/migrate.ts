import './load-env.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run db:migrate -- [--data-root PATH] [--workspace-root PATH] [--global-db PATH]');
  process.exit(0);
}

const dataRoot = option('--data-root');
const workspaceRoot = option('--workspace-root');
if (process.argv.includes('--legacy-db')) throw new Error('DJI 不支持导入历史数据库；请使用独立数据目录。');
const globalDbPath = option('--global-db');
if (dataRoot) process.env.LOOP_DATA_ROOT = dataRoot;
if (workspaceRoot) process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = workspaceRoot;
if (globalDbPath) process.env.LOOP_GLOBAL_DB_PATH = globalDbPath;

const { migrateDatabase, paths } = await import('../src/infrastructure/database.js');
const db = await migrateDatabase();
console.log(JSON.stringify({
  globalDatabase: paths.dbPath,
  workspace: paths.root,
  historicalImportSupported: false,
}, null, 2));
