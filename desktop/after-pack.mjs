import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function packagedInstallRoot(context) {
  return context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir;
}

export function packagedOperationsSkillTarget(context) {
  return join(packagedInstallRoot(context), '.agents', 'skills', 'loopwork-operations-analyzer');
}

export default async function afterPack(context) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const installRoot = packagedInstallRoot(context);
  const resources = context.electronPlatformName === 'darwin'
    ? join(installRoot, 'Resources')
    : join(context.appOutDir, 'resources');
  const target = join(resources, 'app-server');
  await rm(target, { recursive: true, force: true });
  await cp(join(projectRoot, 'desktop-runtime'), target, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const operationsSkill = packagedOperationsSkillTarget(context);
  await rm(operationsSkill, { recursive: true, force: true });
  await cp(join(projectRoot, '.ai', 'skills', 'loopwork-operations-analyzer'), operationsSkill, {
    recursive: true,
    verbatimSymlinks: true,
  });
}
