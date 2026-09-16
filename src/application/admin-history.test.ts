import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { runAdminCommand } from './admin-command';
import { buildAdminPrompt } from './admin-prompt';
import { boundedAdminHistory } from '../domain/admin-history';

function fixture() {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db');
  const store = new AdminManagementStore(filename);
  store.setIntent('running', 'start');
  const observation = { observationId: 'original-large-contract', scope: 'runtime' as const, scopeKey: 'fixture',
    fingerprint: 'original', sourceVersion: 'v1', origin: 'runtime' as const, summary: 'Original acceptance must remain intact',
    evidence: { originalContract: { oracle: 'Seven actual columns', details: '长任务调查证据'.repeat(12000), sentinel: 'complete-original-tail' } } };
  const repair = store.observe(observation);
  const claim = store.claimNext(store.acquireSupervisor('host')!)!;
  const credential = store.issueCommandCredential(claim);
  return { filename, store, observation, repair, claim, credential };
}

test('large Admin histories have bounded prompt/status excerpts without removing original contracts or investigation evidence', () => {
  const h = fixture();
  try {
    for (let index = 0; index < 80; index++) h.store.recordEvidence(h.claim, `finding-${index}`, 'finding',
      { actualObservation: `finding-${index}`, detail: 'actual-evidence'.repeat(1800) });
    const statusText = runAdminCommand(h.store, h.credential, ['status']);
    const status = JSON.parse(statusText);
    const prompt = buildAdminPrompt(h.store, h.claim, 'node loop-admin.cjs');
    assert.ok(prompt.length <= 60000, `Prompt length ${prompt.length}`);
    assert.ok(statusText.length < 60000, `Status length ${statusText.length}`);
    assert.equal(status.observations[0].truncated, true);
    assert.equal(status.history.evidence.total, 80);
    assert.ok(status.history.evidence.shown < 80);
    assert.equal(status.history.evidence.nextIndex, status.history.evidence.shown);
    assert.match(prompt, /history read --collection observations/);
    assert.match(prompt, /contentHash/);
    assert.equal(h.store.evidence(h.repair.caseId).length, 80);
    assert.match(JSON.stringify(h.store.observations(h.repair.caseId)), /complete-original-tail/);
    assert.equal(statusText.includes(h.credential.token), false);
  } finally { h.store.close(); }
});

test('scoped history read reconstructs the exact large original record across chunks and database restart', () => {
  const h = fixture();
  runAdminCommand(h.store, h.credential, ['status']);
  const expected = JSON.stringify(h.store.observations(h.repair.caseId)[0]);
  h.store.close();
  const restarted = new AdminManagementStore(h.filename);
  try {
    let start = 0;
    let hash: string | undefined;
    let restored = '';
    for (;;) {
      const chunk = JSON.parse(runAdminCommand(restarted, h.credential, ['history', 'read', '--collection', 'observations',
        '--index', '0', '--start', String(start), '--length', '8000', ...(hash ? ['--hash', hash] : [])]));
      assert.ok(chunk.text.length <= 8000);
      assert.equal(chunk.start, start);
      hash ??= chunk.contentHash;
      assert.equal(chunk.contentHash, hash);
      restored += chunk.text;
      if (chunk.nextStart === null) break;
      start = chunk.nextStart;
    }
    assert.equal(restored, expected);
    assert.match(JSON.parse(restored).evidence_json, /complete-original-tail/);
    assert.equal(restarted.getCase(h.repair.caseId)?.status, 'running', 'Inspection is not repair success');
  } finally { restarted.close(); }
});

test('history read requires status and current Case credentials and rejects invalid ranges or a changed record hash', () => {
  const h = fixture();
  const read = (args: string[] = []) => runAdminCommand(h.store, h.credential, ['history', 'read', '--collection', 'attempts',
    '--index', '0', '--start', '0', '--length', '8000', ...args]);
  try {
    assert.throws(() => read(), /先读取 status/);
    runAdminCommand(h.store, h.credential, ['status']);
    const hash = JSON.parse(read()).contentHash;
    h.store.attachProcess(h.claim, 12345, 'actual-start-marker');
    assert.throws(() => read(['--hash', hash]), /发生变化/);
    assert.throws(() => read(['--task-id', 'foreign']), /必须提供/);
    assert.throws(() => h.store.commandReadHistory(h.credential, 'evidence', 0, 0, 8001), /1–8000/);
    assert.throws(() => h.store.commandReadHistory(h.credential, 'evidence', 1, 0, 8000), /不存在/);
    assert.throws(() => runAdminCommand(h.store, { ...h.credential, caseId: 'foreign-case' }, ['history', 'read',
      '--collection', 'observations', '--index', '0', '--start', '0', '--length', '8000']), /凭证无效/);
    h.store.setIntent('stopped', 'stop');
    assert.throws(() => read(), /运行意图/);
  } finally { h.store.close(); }
});

test('bounded history metadata never claims omitted rows were read and small histories remain fully readable', () => {
  const rows = [{ original: 'oracle' }, { original: 'evidence' }];
  assert.deepEqual(boundedAdminHistory(rows, 'observations', 8000), { rows, total: 2, shown: 2, nextIndex: null });
  const omitted = boundedAdminHistory(Array.from({ length: 200 }, () => ({ actual: 'fact'.repeat(1000) })), 'evidence', 1000);
  assert.equal(omitted.total, 200);
  assert.equal(omitted.nextIndex, omitted.shown);
  assert.ok(JSON.stringify(omitted.rows).length <= 1000);
});

test('bounded history consumes lazy rows only until the presentation budget, preserving total and next index', () => {
  let reads = 0;
  function* rows() {
    for (let index = 0; index < 10000; index++) {
      reads++;
      yield { index, actual: 'original-fact'.repeat(1000) };
    }
  }
  const excerpt = boundedAdminHistory(rows(), 'evidence', 1000, 10000);
  assert.equal(excerpt.total, 10000);
  assert.equal(excerpt.nextIndex, excerpt.shown);
  assert.ok(reads <= excerpt.shown + 1);
  assert.ok(reads < 10, `Read ${reads} rows for a 1000 character budget`);
  assert.ok(JSON.stringify(excerpt.rows).length <= 1000);
});

test('status, prompt and scoped reads use bounded database lookups instead of full history loaders', () => {
  const h = fixture();
  try {
    for (let index = 0; index < 100; index++) h.store.recordEvidence(h.claim, `large-${index}`, 'finding',
      { index, detail: 'actual-unabridged-evidence'.repeat(1200), sentinel: `complete-tail-${index}` });
    const expected = JSON.stringify(h.store.evidence(h.repair.caseId)[99]);
    const originals = Object.fromEntries(['observations', 'evidence', 'attempts', 'followupEvidence', 'diagnosisHistory']
      .map(name => [name, Object.getOwnPropertyDescriptor(AdminManagementStore.prototype, name)!]));
    try {
      for (const name of Object.keys(originals)) Object.defineProperty(h.store, name, { configurable: true,
        value: () => { throw new Error(`Full collection ${name} must not be read`); } });
      const status = JSON.parse(runAdminCommand(h.store, h.credential, ['status']));
      assert.equal(status.history.evidence.total, 100);
      assert.ok(status.history.evidence.shown < 100);
      assert.ok(buildAdminPrompt(h.store, h.claim, 'node loop-admin.cjs').length <= 60000);
      let restored = '';
      let start = 0;
      let hash: string | undefined;
      for (;;) {
        const chunk = h.store.commandReadHistory(h.credential, 'evidence', 99, start, 8000, hash);
        assert.equal(chunk.total, 100);
        restored += chunk.text;
        hash ??= chunk.contentHash;
        if (chunk.nextStart === null) break;
        start = chunk.nextStart;
      }
      assert.equal(restored, expected);
      assert.match(restored, /complete-tail-99/);
      h.store.setIntent('stopped', 'stop-bounded-reader');
      assert.throws(() => h.store.commandReadHistory(h.credential, 'evidence', 99, 0, 8000), /运行意图/);
    } finally {
      for (const name of Object.keys(originals)) Reflect.deleteProperty(h.store, name);
    }
    assert.equal(h.store.evidence(h.repair.caseId).length, 100, 'No evidence was deleted to bound loading');
  } finally { h.store.close(); }
});
