import { readRepairWorkspaceVersion, readRuntimeArtifactVersion } from '../../src/infrastructure/repair-workspace-version';
import {runtimeArtifactSchema} from '../../src/domain/runtime-update';

const args = process.argv.slice(2);
if(args.length===2 && args[0]==='--runtime-artifact' && args[1]) {
  Promise.resolve().then(()=>readRuntimeArtifactVersion(runtimeArtifactSchema.parse(JSON.parse(args[1])))).then(version=>process.stdout.write(`${version}\n`)).catch(error=>{
    process.stderr.write(`workspace-version: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;
  });
}else if (args.length !== 2 || args[0] !== '--workspace-root' || !args[1]) {
  process.stderr.write('workspace-version: requires --workspace-root <owned workspace>\n');
  process.exitCode = 1;
} else {
  readRepairWorkspaceVersion(args[1]).then(version => process.stdout.write(`${version}\n`)).catch(error => {
    process.stderr.write(`workspace-version: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
