import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import {AdminManagementStore} from '../infrastructure/admin-management-store';
import {createExternalRuntimeStatus} from './external-runtime-status';

test('corrupt actual business database does not hide independent stopped/update control or fabricate business status',async()=>{
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());mkdirSync(root,{recursive:true});
  const store=new AdminManagementStore(join(root,'admin-management.db'));
  const path=join(root,'loop-ui.db');writeFileSync(path,'not a SQLite database');
  try{
    store.setUpdateSilence(true,'publisher-update');
    const before=store.control();
    const status=createExternalRuntimeStatus({control:()=>store.control(),hosts:()=>store.runtimeHostProcesses(),
      inspectBusiness:async()=>{const db=new Database(path,{readonly:true,fileMustExist:true});
        try{db.prepare('SELECT name FROM sqlite_master').all();throw new Error('corrupt database unexpectedly readable');}
        finally{db.close();}},onError:()=>{throw new Error('logging also failed');}});
    const observed=await status();
    assert.deepEqual(observed.control,before);assert.deepEqual(observed.hosts,[]);
    assert.equal(observed.business,undefined);assert.equal(observed.businessError,'SQLITE_NOTADB');
    assert.ok(Number.isFinite(Date.parse(observed.observedAt)));
    assert.deepEqual(store.control(),before);
  }finally{store.close();}
});

test('untrusted diagnostic messages and codes are not exposed; absent DB remains a distinct factual result',async()=>{
  const status=createExternalRuntimeStatus({control:()=>({desired:'stopped'}),hosts:()=>[],
    inspectBusiness:async()=>{throw {code:'private/path/token',message:'sensitive diagnostic'};}});
  assert.equal((await status()).businessError,'BUSINESS_DIAGNOSTIC_UNAVAILABLE');
  const absent=createExternalRuntimeStatus({control:()=>({desired:'stopped'}),hosts:()=>[],
    inspectBusiness:async()=>({databasePresent:false,knownProtocol:false,managed:[],executions:[],runs:[]})});
  assert.equal((await absent()).business?.databasePresent,false);
  assert.equal((await absent()).businessError,undefined);
});
