import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {harnessBuildEnvironment} from '../../scripts/harness-build-environment.mjs';

test('isolated compiler binds frozen source/private data and cannot inherit live Loop control or workspace credentials',()=>{
  const root=join(tmpdir(),'controlled-build'),source=join(root,'source');
  const inherited={PATH:'/controlled/bin',NODE_OPTIONS:'--require live-bootstrap',NODE_PATH:'/live/modules',NODE_TEST_CONTEXT:'child-test',NODE_ENV:'development',
    LOOP_APP_ROOT:'/live/app',LOOP_DATA_ROOT:'/live/data',LOOP_WORKSPACE_ROOT:'/live/repo',LOOP_WORKSPACE_ROOT_OVERRIDE:'/live/override',
    LOOP_GLOBAL_DB_PATH:'/live/business.db',LOOP_LEGACY_DB_PATH:'/live/legacy.db',LOOP_ADMIN_DB:'/live/admin.db',LOOP_ADMIN_COMMAND_TOKEN:'controlled-secret',
    LOOP_INTERNAL_COMMAND_TOKEN:'controlled-internal',LOOP_TEST:'1',LOOP_EXECUTION_ID:'live-execution',LOOP_DESKTOP_NODE:'/live/electron',
    loop_data_root:'/lower/live-data',loop_admin_command_token:'controlled-lower-secret',node_options:'--require lower-live-bootstrap',node_env:'development'};
  const env=harnessBuildEnvironment(root,source,inherited);
  assert.equal(env.PATH,inherited.PATH);assert.equal(env.NODE_ENV,'production');assert.equal(env.NODE_OPTIONS,'');assert.equal(env.NODE_PATH,'');
  assert.equal(env.LOOP_APP_ROOT,source);assert.equal(env.LOOP_DATA_ROOT,join(root,'build-data'));
  assert.equal(env.LOOP_GLOBAL_DB_PATH,join(root,'build-data','loop-ui.db'));
  assert.equal(env.LOOP_WORKSPACE_ROOT_OVERRIDE,join(root,'build-workspace'));assert.equal(env.LOOP_WORKSPACE_ROOT,env.LOOP_WORKSPACE_ROOT_OVERRIDE);
  assert.equal(env.LOOP_LEGACY_DB_PATH,join(root,'build-workspace','no-external-legacy.db'));
  for(const key of ['NODE_TEST_CONTEXT','LOOP_ADMIN_DB','LOOP_ADMIN_COMMAND_TOKEN','LOOP_INTERNAL_COMMAND_TOKEN','LOOP_TEST','LOOP_EXECUTION_ID','LOOP_DESKTOP_NODE','loop_data_root','loop_admin_command_token','node_options','node_env'])assert.equal(key in env,false);
  assert.equal(inherited.LOOP_DATA_ROOT,'/live/data','caller environment is not mutated');
});

test('compiler environment refuses a source outside its exact private root or the private root itself',()=>{
  const root=join(tmpdir(),'controlled-build');
  assert.throws(()=>harnessBuildEnvironment(root,root,{}),/隔离源码目录/);
  assert.throws(()=>harnessBuildEnvironment(root,join(tmpdir(),'other-build','source'),{}),/隔离源码目录/);
  assert.throws(()=>harnessBuildEnvironment('relative','relative/source',{}),/隔离源码目录/);
});
