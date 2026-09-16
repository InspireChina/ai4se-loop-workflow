import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { decodeHarnessSource, extractHarnessSource } from './harness-source.mjs';

// This helper has no business imports or database credentials. It may run
// outside the runtime that is about to be replaced.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--runtime-root' || args[2] !== '--workspace'
  || !isAbsolute(args[1]) || !isAbsolute(args[3]) || args.some(arg => /[\x00-\x1f]/.test(arg))) throw new Error('Usage: harness-source-cli.mjs --runtime-root <absolute installed root> --workspace <new absolute directory>');
const root = args[1];
const relation = relative(resolve(root), resolve(args[3]));
if (!relation || (!relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && relation !== '..' && !isAbsolute(relation))) throw new Error('Repair workspace must be outside the installed runtime');
const bytes = await readFile(join(root, 'harness-source.json.gz'));
const source = decodeHarnessSource(bytes);
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const buildId = (await readFile(join(root, '.next', 'BUILD_ID'), 'utf8')).trim();
if (version !== source.version || buildId !== source.build.buildId) throw new Error('Installed Harness version does not match archived source');
console.log(JSON.stringify(await extractHarnessSource(bytes, args[3])));
