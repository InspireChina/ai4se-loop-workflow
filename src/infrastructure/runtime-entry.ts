import { join } from 'node:path';
import { paths } from './database';

export function runtimeScript(name: string) { return join(paths.appRoot, 'scripts', 'loop', `${name}.ts`); }
export function loopAgentExecutable() { return join(paths.appRoot, 'scripts', 'loop', 'loop-agent.mjs'); }
export function loopAgentCommand() { return `${JSON.stringify(process.execPath)} ${JSON.stringify(loopAgentExecutable())}`; }
