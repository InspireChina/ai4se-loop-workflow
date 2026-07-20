import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { paths } from './database';

test('database tests use a process-local root outside the repository', () => {
  const repository = resolve(process.cwd());
  const dataRoot = resolve(paths.dataRoot);
  const relation = relative(repository, dataRoot);

  assert.equal(process.env.LOOP_TEST, '1');
  assert.equal(process.env.LOOP_TEST_SETUP_PID, String(process.pid));
  assert.equal(paths.appRoot, repository);
  assert.ok(relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation), `test data root escaped isolation: ${dataRoot}`);
  assert.notEqual(paths.dataRoot, resolve(repository, 'data'));
  assert.match(paths.dbPath, /loop-ui\.db$/);
});
