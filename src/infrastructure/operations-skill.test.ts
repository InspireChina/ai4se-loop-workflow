import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Database from 'better-sqlite3';
import { packagedInstallRoot, packagedOperationsSkillTarget } from '../../desktop/after-pack.mjs';

const execFileAsync = promisify(execFile);

test('packages operational skills under the installation .agents directory', () => {
  const packager = { appInfo: { productFilename: 'LoopWork' } };
  assert.equal(packagedInstallRoot({ electronPlatformName: 'win32', appOutDir: 'C:\\LoopWork', packager }), 'C:\\LoopWork');
  assert.equal(
    packagedOperationsSkillTarget({ electronPlatformName: 'win32', appOutDir: 'C:\\LoopWork', packager }),
    join('C:\\LoopWork', '.agents', 'skills', 'loopwork-operations-analyzer'),
  );
  assert.equal(
    packagedInstallRoot({ electronPlatformName: 'darwin', appOutDir: '/tmp/mac', packager }),
    '/tmp/mac/LoopWork.app/Contents',
  );
});

test('operational skill analyzes command corrections without mutating the production database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loopwork-operations-skill-'));
  const databasePath = join(root, 'loop-ui.db');
  const outputDirectory = join(root, 'report');
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(name) VALUES('101_builtin_acceptance.sql');
      CREATE TABLE execution_attempts(
        execution_id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, agent TEXT, pipeline TEXT,
        attempt INTEGER, status TEXT, failure_kind TEXT, last_error TEXT,
        dispatch_generation_key TEXT, created_at TEXT, finished_at TEXT
      );
      CREATE TABLE execution_receipts(
        receipt_id TEXT PRIMARY KEY, execution_id TEXT, kind TEXT, receipt_key TEXT,
        payload_json TEXT, created_at TEXT
      );
      CREATE TABLE runtime_events(
        event_id INTEGER PRIMARY KEY, timestamp TEXT, event_name TEXT, component TEXT,
        severity_text TEXT, severity_number INTEGER, body TEXT,
        exception_fingerprint TEXT, exception_message TEXT
      );
      CREATE TABLE loop_runs(run_id TEXT PRIMARY KEY, status TEXT, started_at TEXT);
      INSERT INTO execution_attempts VALUES(
        'execution-1', 'run-1', 'task-1', 'analyst-agent', 'analysis',
        2, 'applied', NULL, NULL, 'generation-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO loop_runs VALUES('run-1', 'stopped', CURRENT_TIMESTAMP);
      INSERT INTO runtime_events VALUES(
        1, CURRENT_TIMESTAMP, 'loop.agent.tool', 'agent-executor', 'ERROR', 17,
        'sample provider failure', 'fingerprint-1', 'provider unavailable'
      );
    `);
    const executable = 'C:\\Program Files\\LoopWork\\resources\\app-server\\desktop-runners\\loop-agent.cjs';
    const legacy = `node "${executable}" delivery-analysis impact resolve --disposition invalid`;
    const generic = `node "${executable}" artifact put --artifact verification --block results --key case-1 --content-file result.yaml`;
    const receipts: Array<[string, string, object]> = [
      ['receipt-1', '00000001', { phase: 'completed', success: false, input: { command: legacy }, summary: 'Outcome: rejected' }],
      ['receipt-2', '00000002', { phase: 'completed', success: true, input: { command: legacy }, summary: 'Outcome: accepted' }],
      ['receipt-3', '00000003', {
        phase: 'completed', success: false, input: { command: generic }, summary: 'Outcome: rejected',
        commandOutcome: 'rejected', commandErrorCode: 'schema_enum', commandErrorPath: 'verification/results/case-1.status',
      }],
    ];
    const insert = db.prepare(`
      INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json, created_at)
      VALUES(?, 'execution-1', 'tool_event', ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const [receiptId, receiptKey, payload] of receipts) {
      insert.run(receiptId, receiptKey, JSON.stringify(payload));
    }
  } finally {
    db.close();
  }

  try {
    const script = resolve('.ai/skills/loopwork-operations-analyzer/scripts/analyze-logs.cjs');
    const { stdout } = await execFileAsync(process.execPath, [
      script, '--db', databasePath, '--days', '30', '--output-dir', outputDirectory,
    ]);
    const result = JSON.parse(stdout) as { facts: string; report: string };
    const facts = JSON.parse(await readFile(result.facts, 'utf8')) as {
      commands: {
        completed: number;
        succeeded: number;
        selfCorrected: number;
        byProtocol: Array<{ name: string; count: number }>;
        byErrorCode: Array<{ name: string; count: number }>;
      };
      runtimeErrors: { total: number };
    };
    assert.equal(facts.commands.completed, 3);
    assert.equal(facts.commands.succeeded, 1);
    assert.equal(facts.commands.selfCorrected, 1);
    assert.deepEqual(facts.commands.byProtocol, [
      { name: 'legacy', count: 2 },
      { name: 'generic-yaml', count: 1 },
    ]);
    assert.deepEqual(facts.commands.byErrorCode, [
      { name: '(unclassified)', count: 1 },
      { name: 'schema_enum', count: 1 },
    ]);
    assert.equal(facts.runtimeErrors.total, 1);
    assert.match(await readFile(result.report, 'utf8'), /legacy 与 generic-yaml 必须分别分析/);
    const readonly = new Database(databasePath, { readonly: true });
    try {
      const count = readonly.prepare('SELECT COUNT(*) AS count FROM execution_attempts').get() as { count: number };
      assert.equal(count.count, 1);
    } finally {
      readonly.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
