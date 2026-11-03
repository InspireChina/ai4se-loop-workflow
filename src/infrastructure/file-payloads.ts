import { decisionTables, installDecisionTreeStorage, registerDecisionTreeStorage } from './decision-tree-files';
import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  'title', 'template_title', 'display_name', 'trigger_condition', 'blocked_reason',
  'paused_reason', 'last_error', 'failure_reason', 'application_error', 'error',
  'last_reason', 'triage_reason', 'reason', 'command', 'metadata_value', 'link',
  'configured_model', 'setting_value', 'timezone', 'local_time',
]);
// Configuration values and human labels are content too. Restrict `name` to
// these tables: schema-migration names and stable workflow keys remain SQL state.
const tablePayloadColumns: Record<string, readonly string[]> = {
  projects: ['name'],
  stories: ['actor'], // Business participant prose; event.actor remains an operational identity.
  command_chain_acceptance_items: ['source'], // Narrative provenance, not a source-kind enum.
  global_runtime_configurations: ['name', 'omp_model', 'omp_thinking'],
  execution_attempts: ['reasoning_effort'],
};
export function isFilePayloadColumn(table: string, column: string) {
  return payloadColumns.has(column) || Boolean(tablePayloadColumns[table]?.includes(column)) || column.endsWith('_json');
}
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
  // AFTER triggers replace incoming content with file references. Erase the
  // superseded cells/overflow pages, and never spill their intermediate dirty
  // pages to the WAL before that replacement finishes. Logical row checks alone
  // would miss plaintext left in free pages or earlier WAL frames.
  db.pragma('secure_delete = ON');
  db.pragma('cache_spill = OFF');
  const key=keyFor(dataRoot);
  const sign=(path:string,node?:string,field?:string)=>createHmac('sha256',key).update(node === undefined ? path : JSON.stringify([path,node,field])).digest('hex');
  const reference=(path:string,node?:string,field?:string)=>JSON.stringify({$loopworkPayload:1,path,mac:sign(path,node,field),...(node === undefined ? {} : {node,field})});
  type CachedFile={mtime:number;size:number;text:string;json?:{nodes:Record<string,unknown>[]}};
  const files=new Map<string,CachedFile>();
  function file(path:string) {
    const info=statSync(path);const previous=files.get(path);
    if(previous?.mtime===info.mtimeMs&&previous.size===info.size)return previous;
    const value:CachedFile={mtime:info.mtimeMs,size:info.size,text:readFileSync(path,'utf8')};
    if(files.size>=64)files.delete(files.keys().next().value!);
    files.set(path,value);return value;
  }
  function pointer(value:unknown) {
    if(typeof value!=='string'||!value.startsWith(marker))return null;
    let parsed:{path:string;mac:string;node?:string;field?:string};
    try{parsed=JSON.parse(value);}catch{return null;}
    if(typeof parsed.path!=='string'||typeof parsed.mac!=='string')return null;
    if(parsed.node!==undefined&&(typeof parsed.node!=='string'||typeof parsed.field!=='string'))return null;
    const expected=Buffer.from(sign(parsed.path,parsed.node,parsed.field));const actual=Buffer.from(parsed.mac);
    return expected.length===actual.length&&timingSafeEqual(expected,actual)?parsed:null;
  }
  function read(value: unknown): unknown {
    const ref=pointer(value);if(!ref)return value;
    const stored=file(ref.path);
    if(ref.node===undefined)return stored.text;
    stored.json ||= JSON.parse(stored.text);
    const node=stored.json!.nodes.find(node=>node.id===ref.node);
    if(!node||!Object.hasOwn(node,ref.field!))throw new Error(`决策树节点或字段不存在：${ref.node}/${ref.field}`);
    const result=node[ref.field!];
    return result!==null&&typeof result==='object'?JSON.stringify(result):result;
  }
  function store(table: unknown,column: unknown,value: unknown) {
    if (typeof value!=='string' || !value.length || read(value)!==value) return value;
    const digest=createHash('sha256').update(value).digest('hex');
    const file=join(documentFilesRoot(),'payloads',String(table),String(column),`${digest}${String(column).endsWith('_json') ? '.json' : '.txt'}`);
    mkdirSync(dirname(file),{recursive:true});
    if (!existsSync(file)) { const tmp=`${file}.${randomUUID()}.tmp`; writeFileSync(tmp,value,{mode:0o600}); renameSync(tmp,file); }
    return reference(file);
  }
  db.function('loopwork_read_payload',{deterministic:true},read);
  db.function('loopwork_store_payload',store);
  db.function('loopwork_payload_path',(value:unknown)=>pointer(value)?.path || null);
  registerDecisionTreeStorage(db,read,reference);
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
  // Upgrade guards and convert content atomically; concurrent CLI connections
  // must never observe a window with a content trigger temporarily missing.
  db.transaction(() => installPayloadColumnsInsideTransaction(db)).immediate();
}
function installPayloadColumnsInsideTransaction(db: Database.Database) {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const installed=new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[]).map(row=>[row.name,row.sql]));
  for(const {name} of tables) {
    if(!/^[a-z_][a-z_0-9]*$/i.test(name))continue;
    const columns=db.prepare(`PRAGMA table_info("${name}")`).all() as {name:string;type:string}[];
    const decisionFields=Object.entries(decisionTables).find(([table])=>table===name)?.[1].fields as readonly string[] | undefined;
    for(const column of columns.filter(c=>isFilePayloadColumn(name,c.name)&&!decisionFields?.includes(c.name))) {
      if(!/^[a-z_][a-z_0-9]*$/i.test(column.name))continue;
      const field=column.name, trigger=`file_${name}_${field}`;
      let needsConversion=false;
      for(const event of ['INSERT','UPDATE OF "'+field+'"']) {
        const suffix=event==='INSERT'?'insert':'update';
        const triggerName=`${trigger}_${suffix}`;
        if(!installed.get(triggerName)?.includes('loopwork_payload_path(')) {
          db.exec(`DROP TRIGGER IF EXISTS "${triggerName}"`);
          needsConversion=true;
        }
        db.exec(`CREATE TRIGGER IF NOT EXISTS "${triggerName}" AFTER ${event} ON "${name}"
          WHEN typeof(NEW."${field}")='text' AND length(NEW."${field}")>0 AND loopwork_payload_path(NEW."${field}") IS NULL
          BEGIN UPDATE "${name}" SET "${field}"=loopwork_store_payload('${name}','${field}',NEW."${field}") WHERE rowid=NEW.rowid; END;`);
      }
      // A marker-shaped literal is content unless its signature is valid.
      // Existing current guards already cover writes; avoid rescanning files on
      // every process startup once this column has been converted.
      if(needsConversion) db.exec(`UPDATE "${name}" SET "${field}"=loopwork_store_payload('${name}','${field}',"${field}") WHERE typeof("${field}")='text' AND length("${field}")>0 AND loopwork_payload_path("${field}") IS NULL`);
    }
  }
  installDecisionTreeStorage(db);
}
