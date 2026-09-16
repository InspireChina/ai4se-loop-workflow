import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join,win32,posix } from 'node:path';
import { renderRuntimeHostService, type RuntimeHostServiceOptions } from '../src/domain/runtime-host-service';

/** Explicit artifact generation only. Registration is a separate operator
 * action: never replace an existing job or silently install into the OS. */
async function main() {
  const args = new Map<string, string>();
  const raw = process.argv.slice(2);
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index]; const value = raw[index + 1];
    if (!key || !['--platform','--executable','--entry','--app-root','--management-root','--data-root','--output-dir','--config-root','--target','--path','--electron-node'].includes(key)
      || !value || args.has(key)) throw new Error('无效的宿主配置生成参数');
    args.set(key, value);
  }
  const required = (key: string) => { const value = args.get(key); if (!value) throw new Error(`缺少 ${key}`); return value; };
  const target = args.get('--target') || 'standalone';
  if (!['standalone','desktop'].includes(target)) throw new Error('target 必须是 standalone 或 desktop');
  if (target === 'desktop' && (args.has('--entry') || args.has('--electron-node'))) throw new Error('desktop target 不能配置独立 Node 入口');
  if (args.has('--electron-node') && args.get('--electron-node') !== 'true') throw new Error('electron-node 只能显式设为 true');
  const outputDirectory = required('--output-dir');
  const options: RuntimeHostServiceOptions = {
    platform: required('--platform') as RuntimeHostServiceOptions['platform'], executable: required('--executable'),
    appRoot: required('--app-root'), managementRoot:args.get('--management-root'), dataRoot: required('--data-root'), outputRoot: args.get('--config-root') || outputDirectory,
    target: target === 'desktop' ? { kind: 'desktop' } : { kind: 'standalone', entry: args.get('--entry')||(required('--platform')==='win32'?win32:posix).join(required('--app-root'),'desktop-runners','external-host.cjs'), electronNode: args.get('--electron-node') === 'true' },
    path: args.get('--path'),
  };
  // Cross-platform previews are supported, but output lives on THIS machine.
  if (!isAbsolute(outputDirectory)) throw new Error('output-dir 必须是本机绝对路径');
  const result = renderRuntimeHostService(options);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const file of result.files) await writeFile(join(outputDirectory, file.name), file.content, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ label: result.label, outputRoot: outputDirectory, configurationRoot: options.outputRoot, files: result.files.map(file => file.name), registered: false }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
