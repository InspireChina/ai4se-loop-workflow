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

test('registers an Agent under a live Web supervision lease and rejects a stopped intent', async () => {
  const { registerManagedAgentProcess, markManagedAgentProcessExited } = await import('./managed-process-registry');
  const db = await databaseConnection();
  const previous = process.env.LOOP_SUPERVISION_TOKEN;
  const token = 100_001;
  process.env.LOOP_SUPERVISION_TOKEN = String(token);
  try {
    db.prepare('INSERT OR REPLACE INTO loop_supervisor_lease(singleton,owner_id,fencing_token,expires_at) VALUES(1,?,?,?)')
      .run(`web-${process.pid}-fixture`, token, new Date(Date.now() + 60_000).toISOString());
    db.prepare("UPDATE loop_lifecycle_state SET desired_intent='running' WHERE singleton=1").run();
    const marker = await registerManagedAgentProcess('RUN-web-registration', process.pid);
    assert.ok(marker);
    assert.equal(db.prepare('SELECT process_kind FROM loop_managed_processes WHERE run_id=?').pluck().get('RUN-web-registration'),'agent-cli');
    db.prepare("UPDATE loop_lifecycle_state SET desired_intent='stopped' WHERE singleton=1").run();
    await assert.rejects(registerManagedAgentProcess('RUN-stopped-registration', process.pid), /监督代次已经失效/);
    await markManagedAgentProcessExited('RUN-web-registration', process.pid, marker);
  } finally {
    if (previous === undefined) delete process.env.LOOP_SUPERVISION_TOKEN;
    else process.env.LOOP_SUPERVISION_TOKEN = previous;
    db.prepare('DELETE FROM loop_supervisor_lease WHERE fencing_token=?').run(token);
    db.prepare("UPDATE loop_lifecycle_state SET desired_intent='stopped' WHERE singleton=1").run();
  }
});
