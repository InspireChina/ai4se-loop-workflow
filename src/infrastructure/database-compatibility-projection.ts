import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';

type Column={name:string;type:string;notnull:number;dflt_value:string|null;pk:number};
export type DatabaseProjection={
  objects:{type:string;name:string;tbl_name:string;sql:string|null}[];
  tables:{name:string;columns:Column[];foreignKeys:unknown[];rows:number;digest:string}[];
  migrations:string[];
};
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const modulus=1n<<256n;
function tableDefinition(sql:string) {
  let depth=0,closing=-1;let quoteChar='';let comment='';
  for(let index=0;index<sql.length;index++) {
    const char=sql[index],next=sql[index+1];
    if(comment==='line'){if(char==='\n')comment='';continue;}
    if(comment==='block'){if(char==='*'&&next==='/'){comment='';index++;}continue;}
    if(quoteChar){if(char===quoteChar){if(next===quoteChar&&quoteChar!==']')index++;else quoteChar='';}continue;}
    if(char==='-'&&next==='-'){comment='line';index++;continue;}if(char==='/'&&next==='*'){comment='block';index++;continue;}
    if(['\'', '"','`','['].includes(char)){quoteChar=char==='['?']':char;continue;}
    if(char==='(')depth++;if(char===')'&&--depth===0){closing=index;break;}
  }
  if(closing<0)throw new Error('无法完整比较旧表定义');
  return {prefix:sql.slice(0,closing),suffix:sql.slice(closing)};
}
function encode(value:unknown):unknown {
  if(typeof value==='bigint')return {integer:value.toString()};
  if(Buffer.isBuffer(value))return {blob:value.toString('base64')};
  return value;
}

/** Complete streamed projection, not LIMIT-based evidence. It compares all
 * original columns/rows, including duplicate rows, without retaining rows. */
export function projectDatabase(database:Database.Database,original?:DatabaseProjection):DatabaseProjection {
  const deadline=Date.now()+120000;let totalRows=0;let totalBytes=0;
  const objects=database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as DatabaseProjection['objects'];
  if(objects.length>10000)throw new Error('数据库结构超过完整兼容验证上限');
  const tables:DatabaseProjection['tables']=[];
  for(const object of objects.filter(object=>object.type==='table')) {
    const columns=database.prepare(`PRAGMA table_info(${quote(object.name)})`).all() as Column[];
    const foreignKeys=database.prepare(`PRAGMA foreign_key_list(${quote(object.name)})`).all();
    const selected=original?.tables.find(table=>table.name===object.name)?.columns||columns;
    for(const column of selected)if(!columns.some(current=>current.name===column.name))throw new Error(`候选破坏旧列：${object.name}.${column.name}`);
    if(!selected.length||selected.length>1000)throw new Error('数据库列超过完整兼容验证上限');
    let rows=0;let sum=0n;
    if(object.name!=='schema_migrations') {
      const query=database.prepare(`SELECT ${selected.map(column=>quote(column.name)).join(',')} FROM ${quote(object.name)}`).safeIntegers();
      for(const raw of query.iterate()) {
        if(++totalRows>2_000_000||Date.now()>deadline)throw new Error('数据库数据超过完整兼容验证上限');
        const row=raw as Record<string,unknown>;const bytes=JSON.stringify(selected.map(column=>encode(row[column.name])));
        totalBytes+=Buffer.byteLength(bytes);if(totalBytes>4*1024**3)throw new Error('数据库数据超过完整兼容验证字节上限');
        sum=(sum+BigInt(`0x${hash(bytes)}`))%modulus;rows++;
      }
    }
    tables.push({name:object.name,columns,foreignKeys,rows,digest:sum.toString(16).padStart(64,'0')});
  }
  const migrations=objects.some(object=>object.type==='table'&&object.name==='schema_migrations')
    ?(database.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as {name:string}[]).map(row=>row.name):[];
  return {objects,tables,migrations};
}

/** Automatic updates use expand-only schema and preserve existing data.
 * A destructive/data rewriting migration requires a separate compatibility
 * rollout; it cannot silently qualify for automatic code rollback. */
export function assertDatabaseProjectionPreserved(before:DatabaseProjection,after:DatabaseProjection) {
  for(const table of before.tables) {
    const current=after.tables.find(row=>row.name===table.name);if(!current)throw new Error(`候选删除旧表：${table.name}`);
    const oldSql=before.objects.find(row=>row.type==='table'&&row.name===table.name)?.sql;
    const newSql=after.objects.find(row=>row.type==='table'&&row.name===table.name)?.sql;
    if(oldSql!==newSql) {
      if(!oldSql||!newSql)throw new Error(`候选改变旧表定义：${table.name}`);
      const oldDefinition=tableDefinition(oldSql),nextDefinition=tableDefinition(newSql);
      const appended=nextDefinition.prefix.slice(oldDefinition.prefix.length);
      if(!nextDefinition.prefix.startsWith(oldDefinition.prefix)||oldDefinition.suffix!==nextDefinition.suffix
        ||!/^\s*,/.test(appended)||current.columns.length<=table.columns.length
        ||/\b(?:CHECK|REFERENCES|UNIQUE|PRIMARY|GENERATED)\b/i.test(appended))throw new Error(`候选改变旧表定义或兼容约束：${table.name}`);
    }
    for(const column of table.columns) {
      const next=current.columns.find(row=>row.name===column.name);
      if(!next||JSON.stringify(next)!==JSON.stringify(column))throw new Error(`候选破坏旧列：${table.name}.${column.name}`);
    }
    for(const column of current.columns.filter(row=>!table.columns.some(old=>old.name===row.name))) {
      if(column.notnull&&(!column.dflt_value||column.dflt_value.toUpperCase()==='NULL'))throw new Error(`候选新增无兼容默认值的必填列：${table.name}.${column.name}`);
    }
    if(JSON.stringify(current.foreignKeys)!==JSON.stringify(table.foreignKeys))throw new Error(`候选修改旧表外键：${table.name}`);
    if(table.name!=='schema_migrations'&&(current.rows!==table.rows||current.digest!==table.digest))throw new Error(`候选修改原有数据：${table.name}`);
  }
  for(const object of before.objects.filter(row=>row.type!=='table')) {
    const current=after.objects.find(row=>row.type===object.type&&row.name===object.name);
    if(JSON.stringify(current)!==JSON.stringify(object))throw new Error(`候选改变旧数据库对象：${object.name}`);
  }
  for(const object of after.objects.filter(row=>row.type==='trigger'&&!before.objects.some(old=>old.type===row.type&&old.name===row.name))) {
    if(before.tables.some(table=>table.name===object.tbl_name))throw new Error(`候选新增影响旧写入的触发器：${object.name}`);
  }
  for(const object of after.objects.filter(row=>row.type==='index'&&!before.objects.some(old=>old.type===row.type&&old.name===row.name))) {
    if(before.tables.some(table=>table.name===object.tbl_name)&&/^CREATE\s+UNIQUE\s+INDEX\b/i.test(object.sql||''))throw new Error(`候选新增限制旧写入的唯一索引：${object.name}`);
  }
  if(before.migrations.some(name=>!after.migrations.includes(name)))throw new Error('候选改写原始迁移历史');
}
