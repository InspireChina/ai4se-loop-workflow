import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHarnessArtifact } from '../scripts/harness-artifact.mjs';

export async function installDesktopRuntimeImages(source,resources) {
  const installed = join(resources, 'app-server');
  const management = join(resources, 'management-bootstrap');
  for (const target of [installed,management]) {
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, verbatimSymlinks: true });
  }
  const [installedArtifact,managementArtifact]=await Promise.all([
    readHarnessArtifact(installed),readHarnessArtifact(management),
  ]);
  if(installedArtifact.artifactId!==managementArtifact.artifactId||installedArtifact.sourceId!==managementArtifact.sourceId
    ||installedArtifact.version!==managementArtifact.version)throw new Error('桌面业务镜像与独立管理镜像来源不一致');
  return {installed:installedArtifact,management:managementArtifact};
}

export default async function afterPack(context) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  await installDesktopRuntimeImages(join(projectRoot, 'desktop-runtime'),resources);
}
