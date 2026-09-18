import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureHarnessSource, encodeHarnessSource, extractHarnessSource } from './harness-source.mjs';
import {harnessBuildEnvironment} from './harness-build-environment.mjs';
import {copyHarnessBuildOutput} from './copy-harness-build-output.mjs';

const root = resolve(import.meta.dirname, '..');
// A failed/new build must never retain a previous source receipt.
const receipt = join(root, '.next', 'harness-source.json.gz');
await rm(receipt, { force: true });
const source = await captureHarnessSource(root);
const privateRoot = await mkdtemp(join(tmpdir(), 'loopwork-harness-build-'));
try {
  const frozen = join(privateRoot, 'source');
  await extractHarnessSource(encodeHarnessSource(source, { buildId: 'source-snapshot' }), frozen);
  // An independent dependency tree avoids writing through package links into
  // the live install. This is build isolation, not a security sandbox for an
  // adversarial compiler or compromised third-party dependency.
  await cp(join(root, 'node_modules'), join(frozen, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const env=harnessBuildEnvironment(privateRoot,frozen);
  await mkdir(env.LOOP_DATA_ROOT,{recursive:true,mode:0o700});
  await mkdir(env.LOOP_WORKSPACE_ROOT,{recursive:true,mode:0o700});
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(frozen, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], { cwd: frozen,env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) process.exitCode = Number(code);
  else {
    if ((await captureHarnessSource(frozen)).sourceId !== source.sourceId) throw new Error('Compiler changed frozen Harness source; candidate cannot be published');
    if ((await captureHarnessSource(root)).sourceId !== source.sourceId) throw new Error('Harness source changed during build; candidate cannot be published');
    const buildId = (await readFile(join(frozen, '.next', 'BUILD_ID'), 'utf8')).trim();
    await mkdir(join(root, '.next'), { recursive: true });
    await copyHarnessBuildOutput(join(frozen, '.next'), join(root, '.next'));
    await writeFile(receipt, encodeHarnessSource(source, { buildId, nodeVersion: process.version, platform: process.platform, arch: process.arch }), { flag: 'wx', mode: 0o600 });
    console.log(`Harness source bound to successful isolated build: ${source.sourceId}`);
  }
} finally {
  // Only this exact mkdtemp-owned build directory; never the checkout/data.
  await rm(privateRoot, { recursive: true, force: true });
}
