import {isAbsolute,join,relative,sep} from 'node:path';

/** A trusted compiler still must not inherit live Loop databases, workspace
 * overrides or command credentials. Its runtime reads belong to this build.
 * @param {string} privateRoot
 * @param {string} frozen
 * @param {Readonly<Record<string,string|undefined>>} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function harnessBuildEnvironment(privateRoot,frozen,environment=process.env) {
  const relation=relative(privateRoot,frozen);
  if(!isAbsolute(privateRoot)||!isAbsolute(frozen)||!relation||relation==='..'||relation.startsWith(`..${sep}`)||isAbsolute(relation))throw new Error('编译环境必须绑定隔离源码目录');
  const clean=Object.fromEntries(Object.entries(environment).filter(([key])=>{
    const canonical=key.toUpperCase();
    return !canonical.startsWith('LOOP_')&&!['NODE_TEST_CONTEXT','NODE_OPTIONS','NODE_PATH','NODE_ENV'].includes(canonical);
  }));
  const data=join(privateRoot,'build-data'),workspace=join(privateRoot,'build-workspace');
  return {...clean,NODE_OPTIONS:'',NODE_PATH:'',NODE_ENV:'production',
    LOOP_APP_ROOT:frozen,LOOP_DATA_ROOT:data,LOOP_GLOBAL_DB_PATH:join(data,'loop-ui.db'),
    LOOP_WORKSPACE_ROOT:workspace,LOOP_WORKSPACE_ROOT_OVERRIDE:workspace,
    LOOP_LEGACY_DB_PATH:join(workspace,'no-external-legacy.db')};
}

/** Test setup mints a separate database/workspace for every process. Compiler
 * overrides must not pin all parallel files to the same build database.
 * @param {Readonly<Record<string,string|undefined>>} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function harnessTestEnvironment(environment=process.env){
  return {...Object.fromEntries(Object.entries(environment).filter(([key])=>!key.toUpperCase().startsWith('LOOP_')
    &&!['NODE_TEST_CONTEXT','NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))),
    NODE_OPTIONS:'',NODE_PATH:'',NODE_ENV:'test'};
}
