import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { copyHarnessBuildOutput } from '../../scripts/copy-harness-build-output.mjs';

test('copied Next output materializes aliases before the disposable build root is removed', async () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const source = join(root, 'snapshot', '.next');
  const packageRoot = join(source, 'packages', 'native-module');
  const destination = join(root, 'published', '.next');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'binding.node'), 'packaged-native-module');
  symlinkSync(resolve(packageRoot), join(source, 'native-module-alias'), process.platform === 'win32' ? 'junction' : 'dir');

  await copyHarnessBuildOutput(source, destination);
  rmSync(join(root, 'snapshot'), { recursive: true, force: true });

  assert.equal(readFileSync(join(destination, 'native-module-alias', 'binding.node'), 'utf8'), 'packaged-native-module');
  assert.equal(lstatSync(join(destination, 'native-module-alias')).isSymbolicLink(), false);
});
