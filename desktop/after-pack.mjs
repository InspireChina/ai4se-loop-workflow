import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function afterPack(context) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  const target = join(resources, 'app-server');
  await rm(target, { recursive: true, force: true });
  await cp(join(projectRoot, 'desktop-runtime'), target, {
    recursive: true,
    verbatimSymlinks: true,
  });
}
