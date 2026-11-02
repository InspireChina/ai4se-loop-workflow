#!/usr/bin/env tsx
import './load-env.js';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import next from 'next';
import { resolve } from 'node:path';

const { values } = parseArgs({
  options: {
    production: { type: 'boolean', default: false },
    hostname: { type: 'string', short: 'H', default: process.env.HOST || '127.0.0.1' },
    port: { type: 'string', short: 'p', default: process.env.PORT || '3000' },
    'data-dir': { type: 'string' },
    workspace: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log('Usage: npm run dev -- [--hostname 127.0.0.1] [--port 3000] [--data-dir PATH] [--workspace PATH]\n       npm start -- [same options] (run npm run build first)');
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535');
process.env.LOOP_DATA_ROOT = resolve(values['data-dir'] || process.env.LOOP_DATA_ROOT || 'data/dji');
process.env.LOOP_WORKSPACE_ROOT = resolve(values.workspace || process.env.LOOP_WORKSPACE_ROOT || process.cwd());
if (values.workspace) process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = resolve(values.workspace);
Object.assign(process.env, { NODE_ENV: values.production ? 'production' : 'development' });
// This entry point always hosts the Web runtime.
delete process.env.LOOP_DESKTOP;
delete process.env.LOOP_DESKTOP_NODE;

process.env.NEXT_MANUAL_SIG_HANDLE = '1';
const app = next({ dev: !values.production, hostname: values.hostname, port });
const handle = app.getRequestHandler();
let markReady!: () => void;
const ready = new Promise<void>((resolve) => { markReady = resolve; });
const server = createServer((request, response) => {
  void ready.then(() => handle(request, response)).catch((error) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
let lifecycle: Awaited<ReturnType<typeof import('../src/application/loop-run-lifecycle').webLoopRunLifecycle>> | undefined;
let closing = false;
async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  // Stop accepting requests before stopping Runner and its event subscriptions.
  server.close();
  const deadline = setTimeout(() => process.exit(1), 30_000);
  try {
    await lifecycle?.shutdown();
    server.closeAllConnections();
    await app.close();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(exitCode);
  }
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
try {
  // Bind first so an occupied port cannot start or resume a Runner.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, values.hostname, () => { server.removeListener('error', reject); resolve(); });
  });
  await app.prepare();
  const { webLoopRunLifecycle } = await import('../src/application/loop-run-lifecycle');
  lifecycle = await webLoopRunLifecycle();
  markReady();
  console.log(`LoopWork Web ready: http://${values.hostname!.includes(':') ? `[${values.hostname}]` : values.hostname}:${port}`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
