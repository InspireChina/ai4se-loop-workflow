import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { attachFilePayloads, installFilePayloadColumns, fileAwareSql } from './file-payloads';
import { mkdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('large incoming content leaves no plaintext in SQLite free pages or intermediate WAL frames',()=>{
 const root=mkdtempSync(join(tmpdir(),'loopwork-payload-pages-'));const path=join(root,'state.db');const db=new Database(path);
 const needle='EXTERNAL_ONLY_CONTENT_8b1c6020';const body=needle.repeat(20000);
 try {
  db.pragma('journal_mode = WAL');db.pragma('wal_autocheckpoint = 0');
  // Force the previous implementation to spill before its AFTER trigger runs.
  db.pragma('cache_size = 10');
  attachFilePayloads(db,root);
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,content TEXT,status TEXT)');installFilePayloadColumns(db);
  db.prepare('INSERT INTO items VALUES(?,?,?)').run('one',body,'running');
  assert.equal(db.prepare('SELECT content FROM items').pluck().get(),body);
  assert.equal(readFileSync(path+'-wal').includes(Buffer.from(needle)),false);
  db.pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(path).includes(Buffer.from(needle)),false);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('SQLite persists signed file references while readers, JSON predicates and transactions retain semantics',()=>{
 const db=new Database(':memory:');const raw=db.prepare.bind(db);
 try{
  attachFilePayloads(db,process.env.LOOP_DATA_ROOT!);
  db.exec('CREATE TABLE examples(id TEXT PRIMARY KEY,status TEXT,content TEXT,result_json TEXT)');installFilePayloadColumns(db);
  db.prepare('INSERT INTO examples VALUES(?,?,?,?)').run('one','running','private document body',JSON.stringify({artifact:{content:'same payload'},ok:true}));
  const stored=raw('SELECT * FROM examples').get() as Record<string,string>;
  assert.equal(stored.status,'running');assert.ok(!stored.content.includes('private document body'));assert.ok(stored.content.includes('$loopworkPayload'));
  const pointer=JSON.parse(stored.content);assert.equal(readFileSync(pointer.path,'utf8'),'private document body');
  assert.equal((db.prepare('SELECT content FROM examples').get() as {content:string}).content,'private document body');
  assert.equal(db.prepare("SELECT id FROM examples WHERE json_extract(result_json,'$.artifact.content') = 'same payload'").pluck().get(),'one');
  assert.equal(db.prepare("SELECT json_valid(result_json) FROM examples").pluck().get(),1);
  assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE examples SET content=?').run('rolled back');throw new Error('rollback');})(),/rollback/);
  assert.equal(db.prepare('SELECT content FROM examples').pluck().get(),'private document body');
  assert.deepEqual([...db.prepare('SELECT content FROM examples').pluck().iterate()],['private document body']);
  const forged=JSON.stringify({$loopworkPayload:1,path:'/etc/passwd',mac:'bad'});db.prepare('UPDATE examples SET content=?').run(forged);
  assert.equal(db.prepare('SELECT content FROM examples').pluck().get(),forged);
  const literalPointer=JSON.parse(raw('SELECT content FROM examples').pluck().get() as string);
  assert.notEqual(literalPointer.mac,'bad');
  assert.notEqual(literalPointer.path,'/etc/passwd');
  assert.equal(readFileSync(literalPointer.path,'utf8'),forged);
 }finally{db.close();}
});
test('JSON SQL rewriting preserves literals and supports nested JSON expressions',()=>{
 assert.equal(fileAwareSql("SELECT 'json_extract(fake)', json_extract(json_set(data,'$.x',1),'$.x')"),"SELECT 'json_extract(fake)', json_extract(loopwork_read_payload(json_set(loopwork_read_payload(data),'$.x',1)),'$.x')");
});

test('Workflow outcomes remain queryable SQL state while narrative summaries are file backed', () => {
 const db=new Database(':memory:');const raw=db.prepare.bind(db);
 try {
  attachFilePayloads(db,process.env.LOOP_DATA_ROOT!);
  db.exec("CREATE TABLE outcomes(id TEXT PRIMARY KEY,result TEXT CHECK(result IN ('passed','failed')),summary TEXT,next_step TEXT)");
  installFilePayloadColumns(db);
  db.prepare('INSERT INTO outcomes VALUES(?,?,?,?)').run('result','passed','Verified business result','Prepare the next delivery');
  assert.equal(raw("SELECT COUNT(*) FROM outcomes WHERE result='passed'").pluck().get(),1);
  const stored=raw('SELECT summary,next_step FROM outcomes').get() as Record<string,string>;
  assert.ok(stored.summary.startsWith('{"$loopworkPayload":1,'));
  assert.ok(stored.next_step.startsWith('{"$loopworkPayload":1,'));
  assert.equal(db.prepare('SELECT summary FROM outcomes').pluck().get(),'Verified business result');
 } finally {db.close();}
});

test('task labels, diagnostics, metadata and runtime configuration values are external content, not SQL state', () => {
 const db=new Database(':memory:');const raw=db.prepare.bind(db);
 try {
  attachFilePayloads(db,process.env.LOOP_DATA_ROOT!);
  db.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY,title TEXT,description TEXT,blocked_reason TEXT,run_state TEXT);
    CREATE TABLE project_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT);
    CREATE TABLE requirement_metadata(task_id TEXT,metadata_key TEXT,metadata_value TEXT);
    CREATE TABLE global_runtime_configurations(configuration_id TEXT PRIMARY KEY,name TEXT,omp_model TEXT,omp_thinking TEXT,is_active INTEGER);
    CREATE TABLE stories(task_id TEXT,story_index INTEGER,actor TEXT,PRIMARY KEY(task_id,story_index));
    CREATE TABLE task_events(event_id TEXT PRIMARY KEY,actor TEXT,source TEXT);
    CREATE TABLE command_chain_acceptance_items(acceptance_key TEXT PRIMARY KEY,source TEXT);`);
  raw('INSERT INTO stories VALUES(?,?,?)').run('task',1,'页面使用者');
  raw('INSERT INTO command_chain_acceptance_items VALUES(?,?)').run('acceptance','用户原始要求与已确认业务边界');
  installFilePayloadColumns(db);
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run('task','Readable requirement title','Business objective','Missing browser evidence','blocked');
  db.prepare('INSERT INTO project_settings VALUES(?,?)').run('agent_concurrency','4');
  db.prepare('INSERT INTO requirement_metadata VALUES(?,?,?)').run('task','source.reference_url','https://example.test/spec');
  db.prepare('INSERT INTO global_runtime_configurations VALUES(?,?,?,?,?)').run('config','Team default','ollama/qwen3.6:35b','low',1);
  db.prepare('INSERT INTO task_events VALUES(?,?,?)').run('event','system','workflow');
  const task=raw('SELECT * FROM tasks').get() as Record<string,string>;
  assert.equal(task.task_id,'task');assert.equal(task.run_state,'blocked');
  for(const field of ['title','description','blocked_reason'])assert.ok(task[field].startsWith('{"$loopworkPayload":1,'));
  for(const [table,field] of [['project_settings','setting_value'],['requirement_metadata','metadata_value'],['global_runtime_configurations','name'],['global_runtime_configurations','omp_model'],['global_runtime_configurations','omp_thinking'],['stories','actor'],['command_chain_acceptance_items','source']]) {
    const value=raw(`SELECT ${field} FROM ${table}`).pluck().get() as string;
    assert.ok(value.startsWith('{"$loopworkPayload":1,'));
  }
  assert.equal(db.prepare('SELECT title FROM tasks').pluck().get(),'Readable requirement title');
  assert.equal(db.prepare('SELECT setting_value FROM project_settings').pluck().get(),'4');
  assert.equal(db.prepare('SELECT actor FROM stories').pluck().get(),'页面使用者');
  db.prepare('UPDATE stories SET actor=?').run('文本编辑者');
  assert.ok((raw('SELECT actor FROM stories').pluck().get() as string).startsWith('{"$loopworkPayload":1,'));
  assert.equal(db.prepare('SELECT actor FROM stories').pluck().get(),'文本编辑者');
  assert.equal(raw('SELECT actor FROM task_events').pluck().get(),'system');
  assert.equal(raw("SELECT COUNT(*) FROM task_events WHERE source='workflow'").pluck().get(),1);
  assert.equal(db.prepare('SELECT source FROM command_chain_acceptance_items').pluck().get(),'用户原始要求与已确认业务边界');
  db.prepare('UPDATE command_chain_acceptance_items SET source=?').run('更新后的验收来源说明');
  assert.ok((raw('SELECT source FROM command_chain_acceptance_items').pluck().get() as string).startsWith('{"$loopworkPayload":1,'));
  assert.equal(db.prepare('SELECT source FROM command_chain_acceptance_items').pluck().get(),'更新后的验收来源说明');
  assert.deepEqual(db.prepare('SELECT name,omp_model,omp_thinking,is_active FROM global_runtime_configurations').get(),{name:'Team default',omp_model:'ollama/qwen3.6:35b',omp_thinking:'low',is_active:1});
 } finally {db.close();}
});

test('schema reattachment upgrades prefix-only guards and keeps payload-looking business text in files', () => {
 const db=new Database(':memory:');const raw=db.prepare.bind(db);
 try {
  attachFilePayloads(db,process.env.LOOP_DATA_ROOT!);
  db.exec('CREATE TABLE examples(id TEXT PRIMARY KEY,status TEXT,content TEXT)');
  const prefix='{"$loopworkPayload":1,';
  db.exec(`CREATE TRIGGER file_examples_content_insert AFTER INSERT ON examples
    WHEN substr(NEW.content,1,${prefix.length}) <> '${prefix}'
    BEGIN UPDATE examples SET content=loopwork_store_payload('examples','content',NEW.content) WHERE rowid=NEW.rowid; END;`);
  const literal=JSON.stringify({$loopworkPayload:1,note:'这是正文，不是已签名文件引用'});
  raw('INSERT INTO examples VALUES(?,?,?)').run('one','running',literal);
  assert.equal(raw('SELECT content FROM examples').pluck().get(),literal);
  installFilePayloadColumns(db);
  const stored=raw('SELECT content FROM examples').pluck().get() as string;
  assert.notEqual(stored,literal);
  assert.equal(readFileSync(JSON.parse(stored).path,'utf8'),literal);
  assert.equal(db.prepare('SELECT content FROM examples').pluck().get(),literal);
  assert.equal(raw("SELECT COUNT(*) FROM examples WHERE status='running'").pluck().get(),1);
  const before=raw('SELECT total_changes()').pluck().get();
  installFilePayloadColumns(db);
  assert.equal(raw('SELECT total_changes()').pluck().get(),before);
 } finally {db.close();}
});
