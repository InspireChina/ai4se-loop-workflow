import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';

/** Shared controlled bytes, without registering another file's tests. */
export async function artifactFixture(program='actual installed bytes') {
  const root=join(process.env.LOOP_DATA_ROOT!,`artifact-${randomUUID()}`);await mkdir(root,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations'])await mkdir(join(root,dir));
  for(const path of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,path),path==='package.json'?JSON.stringify({version:'fixture-v1'}):'{}');
  await writeFile(join(root,'scripts','fixture.cjs'),program);
  const source=await captureHarnessSource(root);
  await mkdir(join(root,'.next'));await writeFile(join(root,'.next','BUILD_ID'),'controlled-build');
  await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-build'}));
  await mkdir(join(root,'desktop-runners'));await writeFile(join(root,'desktop-runners','host-service.cjs'),program);
  return {root,descriptor:await writeHarnessArtifact(root)};
}
