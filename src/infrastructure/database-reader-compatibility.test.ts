import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import test from 'node:test';
import { assertKnownMigrationHistory } from './database-reader-compatibility';

test('reader compatibility permits uninitialized databases and complete known migration history without writing anything', () => {
  const db=new Database(':memory:');
  try {
    assertKnownMigrationHistory(db,['001.sql'],'business');assert.equal(db.prepare<[],{total:number}>("SELECT count(*) AS total FROM sqlite_master").get()!.total,0);
    db.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES('001.sql')");
    assertKnownMigrationHistory(db,['001.sql','002.sql'],'application');
    assert.equal(db.prepare<[],{total:number}>('SELECT count(*) AS total FROM schema_migrations').get()!.total,1);
  }finally{db.close();}
});

test('reader compatibility counts ALL unknown migrations, bounds diagnostics and does not mutate retained business data', () => {
  const db=new Database(':memory:');
  try {
    db.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY); CREATE TABLE actual(value TEXT); INSERT INTO actual VALUES('preserve business progress')");
    const insert=db.prepare('INSERT INTO schema_migrations VALUES(?)');
    for(let index=0;index<101;index++)insert.run(`future-${String(index).padStart(3,'0')}.sql`);
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/含 101 个.*future-000\.sql.*future-015\.sql …/);
    assert.equal(db.prepare<[],{value:string}>('SELECT value FROM actual').get()!.value,'preserve business progress');
    assert.equal(db.prepare<[],{total:number}>('SELECT count(*) AS total FROM schema_migrations').get()!.total,101);
    assert.throws(()=>assertKnownMigrationHistory(db,[],'application'),/清单/);
  }finally{db.close();}
});

test('NULL and non-text migration history cannot bypass the downgrade gate or produce unbounded diagnostics',()=>{
  const db=new Database(':memory:');
  try {
    db.exec("CREATE TABLE schema_migrations(name PRIMARY KEY);INSERT INTO schema_migrations VALUES(NULL),(NULL),('001.sql'),(17),(x'3030312e73716c')");
    const before=db.prepare('SELECT typeof(name) AS kind,name FROM schema_migrations').all();
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/含 4 个.*<NULL>/);
    assert.deepEqual(db.prepare('SELECT typeof(name) AS kind,name FROM schema_migrations').all(),before);
    db.prepare('INSERT INTO schema_migrations VALUES(?)').run('x'.repeat(10000));
    try{assertKnownMigrationHistory(db,['001.sql'],'application');assert.fail('corrupt history accepted');}
    catch(error){assert.ok(String(error).length<1500);assert.match(String(error),/含 5 个/);}
    assert.throws(()=>assertKnownMigrationHistory(db,[' '],'application'),/清单/);
  }finally{db.close();}
});

for(const kind of ['application','business'] as const) {
  for(const history of ['future','null'] as const) {
  test(`compiled production ${kind} reader rejects ${history} schema history before journal or migration writes and preserves actual database bytes`, async () => {
    const root=join(process.env.LOOP_DATA_ROOT!,`future-reader-${randomUUID()}`);mkdirSync(root,{recursive:true});
    const filename=join(root,kind==='application'?'loopwork.db':'loop-ui.db');
    const db=new Database(filename);
    db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES(${history==='future'?"'999_future.sql'":'NULL'}); CREATE TABLE actual(value TEXT); INSERT INTO actual VALUES('actual business data')`);db.close();
    const original=readFileSync(filename);
    const bundle=await build({entryPoints:['src/infrastructure/database.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['better-sqlite3'],logLevel:'silent'});
    const program=`const {Module}=require('node:module');const m=new Module(require('node:path').join(process.cwd(),'reader.cjs'),module);m.paths=module.paths;
      m._compile(require('node:fs').readFileSync(0,'utf8'),'reader.cjs');
      (async()=>{try{await m.exports.${kind==='application'?'appDatabaseConnection()':'databaseConnection()'};throw Error('future schema accepted');}
        catch(error){if(!String(error).includes('拒绝降级写入'))throw error;console.log(String(error));}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const env={...process.env,LOOP_APP_ROOT:process.cwd(),LOOP_DATA_ROOT:root,LOOP_GLOBAL_DB_PATH:join(root,'loop-ui.db'),LOOP_WORKSPACE_ROOT_OVERRIDE:join(root,'workspace'),NODE_OPTIONS:''};
    for(const key of Object.keys(env))if(key.startsWith('LOOP_TEST')||key==='NODE_TEST_CONTEXT')delete env[key as keyof typeof env];
    const result=spawnSync(process.execPath,['-e',program],{cwd:process.cwd(),env,input:bundle.outputFiles[0].text,encoding:'utf8',timeout:20000});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,history==='future'?/999_future/:/<NULL>/);
    assert.deepEqual(readFileSync(filename),original);
    const retained=new Database(filename,{readonly:true,fileMustExist:true});
    try {assert.equal(retained.prepare<[],{value:string}>('SELECT value FROM actual').get()!.value,'actual business data');assert.equal(retained.pragma('journal_mode',{simple:true}),'delete');}
    finally{retained.close();}
  });
  }
}

test('retired optional migration histories require an inert compatible schema, not a name-only exemption', () => {
  const db=new Database(':memory:');
  try {
    db.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);INSERT INTO schema_migrations VALUES('102_command_chain_variants.sql');");
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/不支持/);
    db.exec('CREATE TABLE agent_work_drafts(draft_id TEXT PRIMARY KEY,command_chain_variant TEXT)');
    assertKnownMigrationHistory(db,['001.sql'],'business');
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'application'),/不支持/);
    db.exec('CREATE VIEW variant_behavior AS SELECT command_chain_variant FROM agent_work_drafts');
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/不支持/);
    db.exec("DROP VIEW variant_behavior;INSERT INTO schema_migrations VALUES('102_agent_command_rejections.sql');");
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/不支持/);
    db.exec(`CREATE TABLE agent_command_rejections(rejection_id INTEGER,execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
      draft_id TEXT REFERENCES agent_work_drafts(draft_id) ON DELETE SET NULL,command_chain_id TEXT,definition_version INTEGER,
      command TEXT,error_code TEXT,error_path TEXT,signature TEXT,occurrence INTEGER,message TEXT,issues_json TEXT,created_at TEXT)`);
    assertKnownMigrationHistory(db,['001.sql'],'business');
    db.exec('CREATE VIEW rejection_behavior AS SELECT command FROM agent_command_rejections');
    assert.throws(()=>assertKnownMigrationHistory(db,['001.sql'],'business'),/不支持/);
  }finally{db.close();}
});
