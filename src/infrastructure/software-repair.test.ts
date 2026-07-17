import assert from 'node:assert/strict';
import test from 'node:test';
import { softwareRepairInternals } from './software-repair';

test('protects the self-repair engine, migrations, runtime data, and secrets from autonomous patches', () => {
  for (const path of [
    '.env.local',
    'data/project/loop-ui.db',
    'migrations/021_change.sql',
    'app-migrations/002_change.sql',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'next.config.ts',
    'scripts/loop/maintenance-runner.ts',
    'src/application/software-maintenance.ts',
    'src/application/runtime-events.ts',
    'src/infrastructure/software-repair.ts',
    'config/secrets.json',
  ]) assert.equal(softwareRepairInternals.isProtectedPath(path), true, path);

  assert.equal(softwareRepairInternals.isProtectedPath('src/application/tasks.ts'), false);
  assert.equal(softwareRepairInternals.isProtectedPath('app/runs/page.tsx'), false);
});
