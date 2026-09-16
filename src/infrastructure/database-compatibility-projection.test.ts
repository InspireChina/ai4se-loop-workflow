import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import {projectDatabase,assertDatabaseProjectionPreserved} from './database-compatibility-projection';

test('complete original data projection distinguishes duplicates, bigint/blob changes and rows beyond previews',()=>{
  const db=new Database(':memory:');try {
    db.exec('CREATE TABLE records(n INTEGER, v BLOB)');const insert=db.prepare('INSERT INTO records VALUES(?,?)');
    for(let index=0;index<150;index++)insert.run(BigInt(index),Buffer.from([index]));insert.run(9007199254740993n,Buffer.from('large'));
    const before=projectDatabase(db);db.exec('ALTER TABLE records ADD COLUMN note TEXT');
    assert.doesNotThrow(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)));
    db.prepare('UPDATE records SET n=? WHERE n=?').run(9007199254740994n,9007199254740993n);
    assert.throws(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)),/原有数据/);
  }finally{db.close();}
});

test('unchanged column metadata cannot hide changed CHECK constraints or new uniqueness constraints',()=>{
  for(const change of ['DROP TABLE records;CREATE TABLE records(n INTEGER CHECK(n>0))','CREATE UNIQUE INDEX new_unique ON records(n)']) {
    const db=new Database(':memory:');try {
      db.exec('CREATE TABLE records(n INTEGER)');const before=projectDatabase(db);db.exec(change);
      assert.throws(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)),/旧表定义|唯一索引/);
    }finally{db.close();}
  }
});

test('compatible expansion preserves original objects and accepts nullable/defaulted columns, not required columns without defaults',()=>{
  for(const extra of ['optional TEXT','required TEXT NOT NULL DEFAULT \'old-reader\'','required TEXT NOT NULL']) {
    const db=new Database(':memory:');try {
      db.exec('CREATE TABLE records(n INTEGER PRIMARY KEY)');const before=projectDatabase(db);db.exec(`ALTER TABLE records ADD COLUMN ${extra}`);
      if(extra==='required TEXT NOT NULL')assert.throws(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)),/必填列/);
      else assert.doesNotThrow(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)));
    }finally{db.close();}
  }
});

test('schema guard rejects lost original columns, dropped indexes and new triggers changing old writes',()=>{
  for(const change of ['ALTER TABLE records DROP COLUMN v','DROP INDEX record_lookup','CREATE TRIGGER new_writer AFTER INSERT ON records BEGIN UPDATE records SET v=\'mutated\'; END']) {
    const db=new Database(':memory:');try {
      db.exec('CREATE TABLE records(n INTEGER, v TEXT);CREATE INDEX record_lookup ON records(n)');const before=projectDatabase(db);db.exec(change);
      assert.throws(()=>assertDatabaseProjectionPreserved(before,projectDatabase(db,before)),/旧列|旧数据库对象|旧写入/);
    }finally{db.close();}
  }
});
