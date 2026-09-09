import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, opendirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type LegacyDatabaseImportResult = {
  status: 'imported' | 'global-exists' | 'legacy-not-found';
  sourcePath: string;
  targetPath: string;
};

export type LegacyProjectDatabaseIdentity = {
  workspaceRoot: string;
  projectName: string;
  evidence: 'projects' | 'tasks' | 'run-logs';
};

export function legacyProjectDatabasePath(dataRoot: string, workspaceRoot: string) {
  const normalizedRoot = resolve(workspaceRoot);
  const repositoryHash = createHash('sha1').update(normalizedRoot).digest('hex').slice(0, 12);
  return join(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ dataRoot), repositoryHash, 'loop-ui.db');
}

export function discoverLegacyProjectDatabases(dataRoot: string) {
  const root = resolve(/* turbopackIgnore: true */ dataRoot);
  if (!existsSync(/* turbopackIgnore: true */ root)) return [];
  const directory = opendirSync(root);
  const entries = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) entries.push(entry);
  } finally {
    directory.closeSync();
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{12}$/i.test(entry.name))
    .map((entry) => join(/* turbopackIgnore: true */ root, entry.name, 'loop-ui.db'))
    .filter((path) => existsSync(/* turbopackIgnore: true */ path))
    .sort();
}

function hasTable(database: Database.Database, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(database: Database.Database, table: string, column: string) {
  if (!hasTable(database, table)) return false;
  return (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as TableColumn[])
    .some((item) => item.name === column);
}

function normalizedIdentity(workspaceRoot: string, projectName: string, evidence: LegacyProjectDatabaseIdentity['evidence']) {
  const trimmedRoot = workspaceRoot.trim();
  if (!trimmedRoot || !isAbsolute(trimmedRoot)) return null;
  const root = resolve(trimmedRoot);
  return {
    workspaceRoot: root,
    projectName: projectName.trim() || basename(root) || '历史项目',
    evidence,
  } satisfies LegacyProjectDatabaseIdentity;
}

/** Read the historical database without mutating it and recover its original work directory. */
export function inspectLegacyProjectDatabase(sourcePath: string): LegacyProjectDatabaseIdentity | null {
  const database = new Database(resolve(/* turbopackIgnore: true */ sourcePath), { readonly: true, fileMustExist: true });
  try {
    if (hasColumn(database, 'projects', 'workspace_root')) {
      const hasName = hasColumn(database, 'projects', 'name');
      const hasDefault = hasColumn(database, 'projects', 'is_default');
      const row = database.prepare(`
        SELECT ${hasName ? 'name' : "'' AS name"}, workspace_root
        FROM projects
        WHERE trim(workspace_root) != ''
        ORDER BY ${hasDefault ? 'is_default DESC,' : ''} rowid
        LIMIT 1
      `).get() as { name: string; workspace_root: string } | undefined;
      const identity = row && normalizedIdentity(row.workspace_root, row.name, 'projects');
      if (identity) return identity;
    }
    if (hasColumn(database, 'tasks', 'work_dir')) {
      const row = database.prepare(`
        SELECT work_dir, COUNT(*) AS usage_count
        FROM tasks
        WHERE trim(work_dir) != ''
        GROUP BY work_dir
        ORDER BY usage_count DESC, work_dir
        LIMIT 1
      `).get() as { work_dir: string } | undefined;
      const identity = row && normalizedIdentity(row.work_dir, '', 'tasks');
      if (identity) return identity;
    }
    if (hasColumn(database, 'run_logs', 'line')) {
      const rows = database.prepare(`
        SELECT line FROM run_logs
        WHERE line LIKE '%[运行] 工作区=%'
        ORDER BY rowid DESC
        LIMIT 50
      `).all() as { line: string }[];
      for (const row of rows) {
        const workspaceRoot = row.line.match(/\[运行\]\s+工作区=([^\r\n]+)/u)?.[1] || '';
        const identity = normalizedIdentity(workspaceRoot, '', 'run-logs');
        if (identity) return identity;
      }
    }
    return null;
  } finally {
    database.close();
  }
}

export async function backupLegacyDatabase(sourcePath: string, temporaryPath: string) {
  rmSync(temporaryPath, { force: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try { await source.backup(temporaryPath); }
  finally { source.close(); }
}

const MERGE_EXCLUDED_TABLES = new Set([
  'schema_migrations',
  'projects',
  'legacy_project_database_imports',
  'project_settings',
  'agent_runtime_settings',
  'agent_prompts',
  'agent_memory_versions',
  'agent_prompt_candidates',
  'agent_observations',
  'agent_observation_occurrences',
  'agent_observation_comment_evidence',
  'resource_claims',
  'loop_meta',
  'loop_lifecycle_commands',
  'loop_lifecycle_state',
  'loop_managed_processes',
  'loop_supervisor_lease',
  'runtime_event_revisions',
]);

type TableColumn = { name: string; type: string; pk: number };

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function projectIdForLegacySource(sourcePath: string, workspaceRoot: string) {
  return `PRJ-legacy-${createHash('sha256').update(`${resolve(sourcePath)}\0${resolve(workspaceRoot)}`).digest('hex').slice(0, 16)}`;
}

/** Merge one migrated, historical single-project database into the global DB. */
export function mergeLegacyProjectDatabase(input: {
  target: Database.Database;
  sourcePath: string;
  databasePath?: string;
  workspaceRoot: string;
  projectName?: string;
}) {
  const sourcePath = resolve(input.sourcePath);
  const databasePath = resolve(input.databasePath || input.sourcePath);
  const workspaceRoot = resolve(input.workspaceRoot);
  const priorImport = input.target.prepare(`
    SELECT project_id FROM legacy_project_database_imports WHERE source_db_path = ?
  `).get(sourcePath) as { project_id: string } | undefined;
  if (priorImport) return { status: 'already-imported' as const, projectId: priorImport.project_id, copiedRows: 0 };

  input.target.prepare('ATTACH DATABASE ? AS legacy_project').run(databasePath);
  try {
    const sourceProjects = input.target.prepare(`
      SELECT project_id FROM legacy_project.projects ORDER BY is_default DESC, created_at, project_id
    `).all() as { project_id: string }[];
    if (sourceProjects.length !== 1) {
      throw new Error(`历史库必须且只能包含一个项目：${sourcePath}（当前 ${sourceProjects.length} 个）`);
    }
    const existingByRoot = input.target.prepare('SELECT project_id FROM projects WHERE workspace_root = ?')
      .get(workspaceRoot) as { project_id: string } | undefined;
    const sourceProjectId = sourceProjects[0].project_id;
    const idConflict = input.target.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(sourceProjectId);
    const projectId = existingByRoot?.project_id || (idConflict ? projectIdForLegacySource(sourcePath, workspaceRoot) : sourceProjectId);
    let copiedRows = 0;

    input.target.transaction(() => {
      input.target.pragma('defer_foreign_keys = ON');
      if (!existingByRoot) {
        input.target.prepare(`
          INSERT INTO projects(project_id, name, workspace_root, description, is_default)
          VALUES(?, ?, ?, ?, 0)
        `).run(projectId, input.projectName?.trim() || basename(workspaceRoot) || '历史项目', workspaceRoot, '由历史项目数据库迁移');
      }

      const tables = input.target.prepare(`
        SELECT name FROM legacy_project.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as { name: string }[];
      for (const { name } of tables) {
        if (MERGE_EXCLUDED_TABLES.has(name)) continue;
        const targetExists = input.target.prepare(`
          SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?
        `).get(name);
        if (!targetExists) continue;
        const sourceColumns = input.target.prepare(`PRAGMA legacy_project.table_info(${identifier(name)})`).all() as TableColumn[];
        const targetColumns = input.target.prepare(`PRAGMA main.table_info(${identifier(name)})`).all() as TableColumn[];
        const sourceNames = new Set(sourceColumns.map((column) => column.name));
        const shared = targetColumns.filter((column) => sourceNames.has(column.name));
        const primaryKeys = shared.filter((column) => column.pk > 0);
        const integerPrimaryKey = primaryKeys.length === 1 && /^INTEGER$/i.test(primaryKeys[0].type)
          ? primaryKeys[0]
          : undefined;
        const columns = shared.filter((column) => column !== integerPrimaryKey);
        if (!columns.length) continue;
        const select = columns.map((column) => {
          if (column.name === 'project_id') return '?';
          if (name === 'tasks' && column.name === 'work_dir') return '?';
          return `source.${identifier(column.name)}`;
        }).join(', ');
        const params: string[] = [];
        for (const column of columns) {
          if (column.name === 'project_id') params.push(projectId);
          else if (name === 'tasks' && column.name === 'work_dir') params.push(workspaceRoot);
        }
        const result = input.target.prepare(`
          INSERT OR IGNORE INTO main.${identifier(name)}(${columns.map((column) => identifier(column.name)).join(', ')})
          SELECT ${select} FROM legacy_project.${identifier(name)} source
        `).run(...params);
        copiedRows += result.changes;
      }
      input.target.prepare(`
        INSERT INTO legacy_project_database_imports(source_db_path, workspace_root, project_id)
        VALUES(?, ?, ?)
      `).run(sourcePath, workspaceRoot, projectId);
    })();
    return { status: 'imported' as const, projectId, copiedRows };
  } finally {
    input.target.exec('DETACH DATABASE legacy_project');
  }
}

export async function importLegacyProjectDatabase(input: {
  dataRoot: string;
  workspaceRoot: string;
  globalDbPath?: string;
  legacyDbPath?: string;
}): Promise<LegacyDatabaseImportResult> {
  const targetPath = resolve(/* turbopackIgnore: true */ input.globalDbPath || join(/* turbopackIgnore: true */ input.dataRoot, 'loop-ui.db'));
  if (existsSync(/* turbopackIgnore: true */ targetPath)) {
    return {
      status: 'global-exists',
      sourcePath: input.legacyDbPath ? resolve(/* turbopackIgnore: true */ input.legacyDbPath) : '',
      targetPath,
    };
  }
  const sourcePath = resolve(/* turbopackIgnore: true */ input.legacyDbPath || legacyProjectDatabasePath(input.dataRoot, input.workspaceRoot));
  if (!existsSync(/* turbopackIgnore: true */ sourcePath)) return { status: 'legacy-not-found', sourcePath, targetPath };
  if (sourcePath === targetPath) return { status: 'global-exists', sourcePath, targetPath };

  mkdirSync(/* turbopackIgnore: true */ dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.legacy-import-${process.pid}.tmp`;
  rmSync(/* turbopackIgnore: true */ temporaryPath, { force: true });
  try {
    await backupLegacyDatabase(sourcePath, temporaryPath);
    if (!existsSync(/* turbopackIgnore: true */ targetPath)) renameSync(/* turbopackIgnore: true */ temporaryPath, targetPath);
  } finally {
    rmSync(/* turbopackIgnore: true */ temporaryPath, { force: true });
  }
  return { status: 'imported', sourcePath, targetPath };
}
