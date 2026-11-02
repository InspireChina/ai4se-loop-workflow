import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { attachFilePayloads, installFilePayloadColumns, fileAwareSql } from './file-payloads';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';

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
