import assert from 'node:assert/strict';
import test from 'node:test';
import { basename } from 'node:path';
import { resolveRunnerCommand } from './agent-runner';

test('starts TypeScript runners through Node and the local tsx CLI', () => {
  const launch = resolveRunnerCommand('RUN-123', 'dispatch-waiter.ts');

  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /tsx[/\\]dist[/\\]cli\.mjs$/);
  assert.equal(basename(launch.args[1]), 'dispatch-waiter.ts');
  assert.equal(launch.args[2], 'RUN-123');
  assert.ok(!launch.args.includes('npx'));
});
