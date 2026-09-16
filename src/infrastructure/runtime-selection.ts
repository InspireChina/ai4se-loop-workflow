import {existsSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {AdminManagementStore} from './admin-management-store';
import {assertRuntimeDataOutside} from './runtime-paths';
export {stageRuntimeArtifact} from './runtime-staging';
/** Startup selection only. No business imports, workflow writes or automatic
 * guard release. Return a verified selected root, never a stale bootstrap. */
export async function selectInstalledRuntime(bootstrapRoot:string,dataRoot:string) {
  if(!isAbsolute(bootstrapRoot)||!isAbsolute(dataRoot))throw new Error('运行版本选择必须使用绝对路径');
  const bootstrap=resolve(bootstrapRoot),data=resolve(dataRoot);
  const packaged=existsSync(join(bootstrap,'harness-artifact.json'));
  if(packaged)await assertRuntimeDataOutside(bootstrap,data);
  const store=new AdminManagementStore(join(data,'admin-management.db'));
  try {
    const installation=store.runtimeInstallation();
    if(!installation&&packaged) {
      const artifact=await readHarnessArtifact(bootstrap);
      // Ordinary installer upgrades replace their bootstrap directory in
      // place. Do not pin that mutable directory as an automatic-repair
      // selection. An external update explicitly installs immutable roots.
      if(store.runtimeInstallation())throw new Error('启动期间外部安装选择已经建立，请重新选择版本');
      return {root:bootstrap,revision:null,artifact};
    }
    if(!installation)return {root:bootstrap,revision:null,artifact:null};
    await assertRuntimeDataOutside(installation.artifact.root,data);
    const selected=installation.artifact;
    if(JSON.stringify(await readHarnessArtifact(selected.root))!==JSON.stringify(selected))throw new Error('持久化运行版本与实际安装字节不匹配');
    const current=store.runtimeInstallation();
    if(!current||current.revision!==installation.revision)throw new Error('读取运行版本期间安装选择已经改变');
    return {root:selected.root,revision:installation.revision,artifact:selected};
  }finally {store.close();}
}
