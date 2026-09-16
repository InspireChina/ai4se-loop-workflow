import type Database from 'better-sqlite3';

/** Retired optional extensions seen in supported historical installs. They
 * are not future-reader permission: validate their inert schema footprint.
 * Rejections DDL originated at fef9713; variants was a historical nullable
 * draft metadata field, no longer referenced by the current reader. */
function compatibleRetiredHistories(database: Database.Database, kind: 'application' | 'business') {
  if (kind !== 'business') return [];
  const accepted: string[] = [];
  const exists = (name: string) => database.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name);
  if (exists('102_command_chain_variants.sql')) {
    const column = database.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agent_work_drafts') WHERE name='command_chain_variant'").get() as
      { type: string; required: number; dflt_value: string | null } | undefined;
    const activeReferences = database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type IN ('trigger','view') AND lower(sql) LIKE '%command_chain_variant%'").get() as { total: number };
    if (column?.type.toUpperCase() === 'TEXT' && column.required === 0 && column.dflt_value === null && activeReferences.total === 0) accepted.push('102_command_chain_variants.sql');
  }
  if (exists('102_agent_command_rejections.sql')) {
    const columns = database.prepare("SELECT name FROM pragma_table_info('agent_command_rejections') ORDER BY cid").all() as { name: string }[];
    const expected = ['rejection_id','execution_id','draft_id','command_chain_id','definition_version','command','error_code','error_path','signature','occurrence','message','issues_json','created_at'];
    const activeReferences = database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type IN ('trigger','view') AND lower(sql) LIKE '%agent_command_rejections%'").get() as { total: number };
    const references = database.prepare("SELECT \"from\" AS source,\"table\" AS target,\"to\" AS destination,on_delete,on_update FROM pragma_foreign_key_list('agent_command_rejections') ORDER BY \"from\"").all();
    const expectedReferences = [
      {source:'draft_id',target:'agent_work_drafts',destination:'draft_id',on_delete:'SET NULL',on_update:'NO ACTION'},
      {source:'execution_id',target:'execution_attempts',destination:'execution_id',on_delete:'CASCADE',on_update:'NO ACTION'},
    ];
    if (JSON.stringify(columns.map(column=>column.name)) === JSON.stringify(expected) && activeReferences.total === 0
      && JSON.stringify(references) === JSON.stringify(expectedReferences)) accepted.push('102_agent_command_rejections.sql');
  }
  return accepted;
}

/** Before ANY schema/journal mutation, reject an applied migration unknown to
 * this reader. Migration filenames alone cannot prove changed SQL is safe;
 * external candidate validation must also bind original migration contents. */
export function assertKnownMigrationHistory(database: Database.Database, knownNames: readonly string[], kind: 'application' | 'business') {
  if (!knownNames.length || knownNames.length > 10000 || new Set(knownNames).size !== knownNames.length
    || knownNames.some(name=>typeof name!=='string'||!name.trim())) throw new Error('无效数据库读者迁移清单');
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists) return;
  const supported = [...new Set([...knownNames,...compatibleRetiredHistories(database,kind)])];
  const placeholders = supported.map(() => '?').join(',');
  // SQLite permits NULL even in a historical TEXT PRIMARY KEY. NOT IN alone
  // evaluates to NULL for those rows, silently admitting corrupt history.
  const where = `name IS NULL OR typeof(name) <> 'text' OR name NOT IN (${placeholders})`;
  const count = (database.prepare(`SELECT count(*) AS total FROM schema_migrations WHERE ${where}`).get(...supported) as { total: number }).total;
  if (!count) return;
  const preview = database.prepare(`SELECT CASE WHEN name IS NULL THEN '<NULL>' ELSE substr(CAST(name AS TEXT),1,256) END AS name FROM schema_migrations WHERE ${where} ORDER BY name LIMIT 16`).all(...supported) as { name: string }[];
  throw new Error(`${kind} 数据库含 ${count} 个当前代码不支持的已应用迁移，拒绝降级写入：${preview.map(row=>row.name).join(', ')}${count>preview.length?' …':''}`);
}
