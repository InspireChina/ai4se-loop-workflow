import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { documentFilesRoot } from './document-files';

const marker = '{"$loopworkPayload":1,';
const adapted = new WeakSet<object>();
const payloadColumns = new Set([
  'content', 'body', 'message', 'line', 'description', 'answer', 'question',
  'quoted_text', 'guidance', 'yaml_content', 'prompt_content', 'acceptance',
  'answer_message', 'attempted_message', 'decision_text', 'error_output',
  'evidence', 'exception_message', 'exception_stack', 'next_step',
  'observable_outcome', 'oracle', 'rationale', 'recommendation',
  'recommendation_reason', 'remembered_template', 'response_text',
  'risk', 'statement', 'summary', 'template_description', 'why', 'boundary',
]);
const jsonFunctions = new Set(['json','json_extract','json_valid','json_array_length','json_each','json_tree','json_type','json_set','json_insert','json_replace','json_remove','json_patch']);
// Keep SQL's JSON operations working against immutable file payloads. Identifiers and
// quoted SQL text are left intact; only the first argument of JSON functions is read.
export function fileAwareSql(sql: string): string {
  let out = '', i = 0;
  function endQuote(start: number) {
    const quote = sql[start]; let at = start + 1;
    while (at < sql.length) { if (sql[at++] === quote) { if (sql[at] === quote) at++; else break; } }
    return at;
  }
  while (i < sql.length) {
    if (sql[i] === "'" || sql[i] === '"' || sql[i] === '`') { const end = endQuote(i); out += sql.slice(i,end); i=end; continue; }
    const match = sql.slice(i).match(/^([a-z_][a-z_0-9]*)\s*\(/i);
    if (match && jsonFunctions.has(match[1].toLowerCase()) && !/[\w]/.test(sql[i-1] || '')) {
      const start=i+match[0].length; let at=start, depth=0;
      for (; at<sql.length; at++) {
        if (sql[at] === "'" || sql[at] === '"' || sql[at] === '`') { at=endQuote(at)-1; continue; }
        if (sql[at] === '(') depth++;
        if (sql[at] === ')') { if (!depth) break; depth--; }
        if (sql[at] === ',' && !depth) break;
      }
      out += match[0] + 'loopwork_read_payload(' + fileAwareSql(sql.slice(start,at)) + ')'; i=at;
    } else out += sql[i++];
  }
  return out;
}
function keyFor(root: string) {
  mkdirSync(root,{recursive:true}); const path=join(root,'payload-key');
  try { return readFileSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  const key=randomBytes(32);
  try { writeFileSync(path,key,{flag:'wx',mode:0o600}); return key; }
  catch (e) { if ((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; return readFileSync(path); }
}
export function attachFilePayloads(db: Database.Database, dataRoot: string) {
  if (adapted.has(db)) return;
  adapted.add(db);
  const key=keyFor(dataRoot);
  const sign=(path:string)=>createHmac('sha256',key).update(path).digest('hex');
  function read(value: unknown): unknown {
    if (typeof value!=='string' || !value.startsWith(marker)) return value;
    let pointer: {path:string;mac:string};
    try { pointer=JSON.parse(value); } catch { return value; }
    if (typeof pointer.path!=='string' || typeof pointer.mac!=='string') return value;
    const expected=Buffer.from(sign(pointer.path)); const actual=Buffer.from(pointer.mac);
    if (expected.length!==actual.length || !timingSafeEqual(expected,actual)) return value;
    return readFileSync(pointer.path,'utf8');
  }
  function store(table: unknown,column: unknown,value: unknown) {
    if (typeof value!=='string' || !value.length || read(value)!==value) return value;
    const digest=createHash('sha256').update(value).digest('hex');
    const file=join(documentFilesRoot(),'payloads',String(table),String(column),`${digest}.txt`);
    mkdirSync(dirname(file),{recursive:true});
    if (!existsSync(file)) { const tmp=`${file}.${randomUUID()}.tmp`; writeFileSync(tmp,value,{mode:0o600}); renameSync(tmp,file); }
    return JSON.stringify({$loopworkPayload:1,path:file,mac:sign(file)});
  }
  db.function('loopwork_read_payload',{deterministic:true},read);
  db.function('loopwork_store_payload',store);
  function hydrate(value: unknown): unknown {
    if (typeof value==='string') return read(value);
    if (Array.isArray(value)) return value.map(hydrate);
    if (value && typeof value==='object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,hydrate(v)]));
    return value;
  }
  const prepare=db.prepare.bind(db);
  const exec=db.exec.bind(db);
  db.exec=((sql:string)=>exec(fileAwareSql(sql))) as typeof db.exec;
  db.prepare=((sql:string)=>{
    const statement=prepare(fileAwareSql(sql));
    const proxy=new Proxy(statement,{get(target,property){
      const method=Reflect.get(target,property);
      if(typeof method!=='function')return method;
      return (...args:unknown[])=>{
        if(property==='iterate') { const iterator=method.apply(target,args); return (function*(){for(const row of iterator)yield hydrate(row);})(); }
        const result=method.apply(target,args);
        if(result===target)return proxy;
        return property==='get'||property==='all' ? hydrate(result) : result;
      };
    }});
    return proxy;
  }) as typeof db.prepare;
}
// Called after schema migrations. State and relationship columns remain in SQLite;
// content fields and JSON snapshots are file references, including SQL-only writes.
export function installFilePayloadColumns(db: Database.Database) {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  for(const {name} of tables) {
    if(!/^[a-z_][a-z_0-9]*$/i.test(name))continue;
    const columns=db.prepare(`PRAGMA table_info("${name}")`).all() as {name:string;type:string}[];
    for(const column of columns.filter(c=>payloadColumns.has(c.name)||c.name.endsWith('_json'))) {
      if(!/^[a-z_][a-z_0-9]*$/i.test(column.name))continue;
      const field=column.name, trigger=`file_${name}_${field}`;
      for(const event of ['INSERT','UPDATE OF "'+field+'"']) {
        const suffix=event==='INSERT'?'insert':'update';
        db.exec(`CREATE TRIGGER IF NOT EXISTS "${trigger}_${suffix}" AFTER ${event} ON "${name}"
          WHEN typeof(NEW."${field}")='text' AND length(NEW."${field}")>0 AND substr(NEW."${field}",1,${marker.length}) <> '{"$loopworkPayload":1,'
          BEGIN UPDATE "${name}" SET "${field}"=loopwork_store_payload('${name}','${field}',NEW."${field}") WHERE rowid=NEW.rowid; END;`);
      }
      // Idempotent: existing references are recognized and remain unchanged.
      db.exec(`UPDATE "${name}" SET "${field}"=loopwork_store_payload('${name}','${field}',"${field}") WHERE typeof("${field}")='text' AND length("${field}")>0 AND substr("${field}",1,${marker.length}) <> '{"$loopworkPayload":1,'`);
    }
  }
}
