import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from './database';
import { registerManagedProcessInDb } from './managed-process-registry';

test('registers the same managed process idempotently without changing its owner run', async () => {
  const db = await databaseConnection();
  const token = 91_000 + Math.floor(Math.random() * 1_000);
  const pid = 41_000 + Math.floor(Math.random() * 1_000);
  const marker = `fixture-${randomUUID()}`;
  const firstId = randomUUID();
  const first = registerManagedProcessInDb(db, {
    processId: firstId,
    supervisionToken: token,
    processKind: 'agent-cli',
    pid,
    processStartMarker: marker,
    runId: 'RUN-idempotent',
  });
  db.prepare(`UPDATE loop_managed_processes SET status = 'exited', exited_at = CURRENT_TIMESTAMP WHERE process_id = ?`).run(first);

  const duplicate = registerManagedProcessInDb(db, {
    processId: randomUUID(),
    supervisionToken: token,
    processKind: 'agent-cli',
    pid,
    processStartMarker: marker,
    runId: 'RUN-idempotent',
  });

  assert.equal(duplicate, firstId);
  assert.deepEqual(db.prepare(`SELECT status, exited_at, run_id FROM loop_managed_processes WHERE process_id = ?`).get(firstId), {
    status: 'running',
    exited_at: null,
    run_id: 'RUN-idempotent',
  });
  assert.throws(() => registerManagedProcessInDb(db, {
    processId: randomUUID(),
    supervisionToken: token,
    processKind: 'agent-cli',
    pid,
    processStartMarker: marker,
    runId: 'RUN-other',
  }), /已属于其他运行/);
});
