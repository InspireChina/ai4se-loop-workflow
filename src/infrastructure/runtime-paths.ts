import {realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,relative,resolve,sep} from 'node:path';

/** Resolve existing ancestors too: macOS /tmp aliases and user junctions
 * must not turn an installed descendant into an apparently external path. */
async function physicalTarget(path:string) {
  if(!isAbsolute(path))throw new Error('运行路径必须为绝对路径');
  let ancestor=resolve(path);const suffix:string[]=[];
  for(let depth=0;depth<128;depth++) {
    try{return resolve(await realpath(ancestor),...suffix);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const parent=dirname(ancestor);if(parent===ancestor)throw new Error('无法解析运行目录实际位置');suffix.unshift(basename(ancestor));ancestor=parent;
  }
  throw new Error('运行路径超过目录解析上限');
}
export async function assertRuntimeDataOutside(root:string,dataRoot:string) {
  const [installed,data]=await Promise.all([physicalTarget(root),physicalTarget(dataRoot)]);const relation=relative(installed,data);
  if(!relation||relation!=='..'&&!relation.startsWith(`..${sep}`)&&!isAbsolute(relation))throw new Error('运行数据不能写入不可变安装目录');
}
