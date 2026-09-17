import {randomUUID} from 'node:crypto';
import {renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';

/** Replace a small control file without exposing a truncated or partial value
 * to another process. The temporary file must share the target directory so
 * the final rename stays atomic. */
export function atomicReplaceFileSync(path:string,content:string|Buffer,mode=0o600) {
  const temporary=join(dirname(path),`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary,content,{flag:'wx',mode});
    renameSync(temporary,path);
  } finally {
    rmSync(temporary,{force:true});
  }
}
