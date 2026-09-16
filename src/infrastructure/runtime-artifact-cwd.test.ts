import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('runtime-owned children start from their immutable selected artifact', () => {
  for (const name of [
    'native-runtime-host.ts',
    'native-runtime-update.ts',
    'native-admin-business-worker.ts',
    'runtime-database-compatibility.ts',
  ]) {
    const source = readFileSync(resolve(process.cwd(), 'src/infrastructure', name), 'utf8');
    assert.match(source, /spawn\([\s\S]*?\{cwd:artifact\.root,/,
      `${name} must not inherit a replaceable bootstrap cwd`);
  }
});
