import { join } from 'node:path';
import { paths } from './database';

export function isDesktopRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.LOOP_DESKTOP === '1';
}

export function runtimeNodeExecutable(env: NodeJS.ProcessEnv = process.env) {
  return isDesktopRuntime(env) ? env.LOOP_DESKTOP_NODE || process.execPath : process.execPath;
}

export function runtimeNodeEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return isDesktopRuntime(env) ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

export function runtimeScript(name: string, env: NodeJS.ProcessEnv = process.env) {
  return isDesktopRuntime(env)
    ? join(paths.appRoot, 'desktop-runners', `${name}.cjs`)
    : join(paths.appRoot, 'scripts', 'loop', `${name}.ts`);
}

export function loopAgentExecutable(env: NodeJS.ProcessEnv = process.env) {
  return isDesktopRuntime(env)
    ? join(paths.appRoot, 'desktop-runners', 'loop-agent.cjs')
    : join(paths.appRoot, 'scripts', 'loop', 'loop-agent.mjs');
}

export function loopAgentCommand(env: NodeJS.ProcessEnv = process.env) {
  const executable = isDesktopRuntime(env) ? runtimeNodeExecutable(env) : 'node';
  return `${JSON.stringify(executable)} ${JSON.stringify(loopAgentExecutable(env))}`;
}
