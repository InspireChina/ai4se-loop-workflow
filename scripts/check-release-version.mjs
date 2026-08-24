import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function json(relativePath) {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), 'utf8'));
}

const [rootPackage, rootLock, desktopPackage, desktopLock] = await Promise.all([
  json('package.json'),
  json('package-lock.json'),
  json('desktop/package.json'),
  json('desktop/package-lock.json'),
]);
const expected = rootPackage.version;
const versions = [{ source: 'package.json', version: expected }, {
  source: 'package-lock.json',
  version: rootLock.version,
}, {
  source: 'package-lock.json packages[""]',
  version: rootLock.packages?.['']?.version,
}, {
  source: 'desktop/package.json',
  version: desktopPackage.version,
}, {
  source: 'desktop/package-lock.json',
  version: desktopLock.version,
}, {
  source: 'desktop/package-lock.json packages[""]',
  version: desktopLock.packages?.['']?.version,
}];
const mismatches = versions.filter((item) => item.version !== expected);
if (mismatches.length) {
  throw new Error(`Release version mismatch; expected ${expected}:\n${mismatches.map((item) => `- ${item.source}: ${item.version || 'missing'}`).join('\n')}`);
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tagVersion = String(process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
  if (tagVersion !== expected) {
    throw new Error(`Release tag ${process.env.GITHUB_REF_NAME || 'missing'} does not match package version ${expected}`);
  }
}

console.log(`Release version ${expected} is consistent across root and desktop manifests.`);
