import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {assertRuntimeDataOutside} from './runtime-paths';

test('physical path guard recognizes missing descendants and ..-prefixed child names as installed data',async()=>{
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(root,{recursive:true});
  await assert.rejects(assertRuntimeDataOutside(root,join(root,'..child','data')),/不可变安装目录/);
  await assert.rejects(assertRuntimeDataOutside(root,root),/不可变安装目录/);
  await assertRuntimeDataOutside(root,join(root,'..','external','missing','data'));
});
test('ancestor aliases cannot hide an installed descendant before any directory/database is created',{skip:process.platform==='win32'},async()=>{
  const base=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(base,{recursive:true});const root=join(base,'installed'),alias=join(base,'alias');await mkdir(root);await symlink(root,alias);
  await assert.rejects(assertRuntimeDataOutside(root,join(alias,'missing','data')),/不可变安装目录/);
  await assert.rejects(assertRuntimeDataOutside(alias,join(root,'missing','data')),/不可变安装目录/);
});
