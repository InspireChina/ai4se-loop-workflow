import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputRoot = resolve(import.meta.dirname, '..', 'dist-desktop');
const extensions = ['.exe', '.dmg', '.zip', '.AppImage', '.deb', '.rpm', '.tar.gz'];
const names = (await readdir(outputRoot))
  .filter((name) => extensions.some((extension) => name.endsWith(extension)))
  .sort();

if (!names.length) throw new Error(`No desktop artifacts found in ${outputRoot}`);

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const lines = [];
for (const name of names) lines.push(`${await sha256(join(outputRoot, name))}  ${name}`);
await writeFile(join(outputRoot, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'ascii');
console.log(`Wrote checksums for ${names.length} artifact(s)`);
