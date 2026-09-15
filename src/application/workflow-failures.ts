import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hash } from '../infrastructure/database';

type Db = Database.Database;

export type WorkflowFailureTest = {
  command: string;
  passed: boolean;
  summary?: string;
};

export type WorkflowFailureObservation = {
  workItemId: string;
  failureSignature: string;
  repositoryFingerprint: string | null;
  contractFingerprint: string;
  stagnationFingerprint: string | null;
  stagnantCount: number;
  shouldArbitrate: boolean;
  previousExecutionId: string | null;
};

type StoredObservation = WorkflowFailureObservation & {
  executionId: string;
};

function normalizedFailureText(value: string | undefined) {
  return (value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, '<id>');
}

function contractContentFingerprint(specJson: string) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
    return value;
  };
  try {
    return hash(JSON.stringify(canonical(JSON.parse(specJson))));
  } catch {
    // Preserve an unreadable contract as evidence; never treat it as empty.
    return hash(specJson);
  }
}

export function workflowFailureSignature(input: {
  failureKind: string;
  summary: string;
  tests?: WorkflowFailureTest[];
}) {
  const failedTests = (input.tests || [])
    .filter((test) => !test.passed)
    .map((test) => ({
      command: normalizedFailureText(test.command),
      summary: normalizedFailureText(test.summary),
    }))
    .sort((left, right) => left.command.localeCompare(right.command) || left.summary.localeCompare(right.summary));
  return hash(JSON.stringify({
    failureKind: input.failureKind,
    failures: failedTests.length ? failedTests : [{ command: '', summary: normalizedFailureText(input.summary) }],
  }));
}

function previousObservation(db: Db, workItemId: string, executionId: string) {
  const rows = db.prepare(`
    SELECT receipt.payload_json
    FROM execution_receipts receipt
    JOIN execution_attempts execution ON execution.execution_id = receipt.execution_id
    JOIN workflow_items failed_item ON failed_item.item_id = execution.work_item_id
    JOIN workflow_items current_item ON current_item.item_id = ?
    WHERE failed_item.task_id = current_item.task_id AND failed_item.work_key = current_item.work_key
      AND execution.execution_id != ?
      AND receipt.kind = 'workflow_failure'
    ORDER BY execution.created_at DESC, execution.rowid DESC, receipt.created_at DESC
  `).all(workItemId, executionId) as { payload_json: string }[];
  for (const row of rows) {
    try {
      return JSON.parse(row.payload_json) as StoredObservation;
    } catch {
      // A malformed historical receipt must not prevent current failure
      // persistence or accidentally trigger arbitration.
    }
  }
  return null;
}

export function observeWorkflowFailureInDb(db: Db, input: {
  executionId: string;
  taskId: string;
  storyIndex: number;
  failureKind: string;
  summary: string;
  tests?: WorkflowFailureTest[];
}) {
  const execution = db.prepare(`
    SELECT execution_id, work_item_id, base_commit
    FROM execution_attempts
    WHERE execution_id = ? AND task_id = ? AND story_index = ? AND agent = 'test-agent'
  `).get(input.executionId, input.taskId, input.storyIndex) as {
    execution_id: string;
    work_item_id: string | null;
    base_commit: string | null;
  } | undefined;
  if (!execution?.work_item_id) return null;
  const recorded = db.prepare(`
    SELECT payload_json FROM execution_receipts
    WHERE execution_id = ? AND kind = 'workflow_failure' AND receipt_key = 'observation'
  `).get(execution.execution_id) as { payload_json: string } | undefined;
  if (recorded) {
    try {
      return JSON.parse(recorded.payload_json) as StoredObservation;
    } catch {
      // Receipts are immutable evidence. Do not silently repair or replace a
      // corrupted historical observation with a different current failure.
      return null;
    }
  }
  const spec = db.prepare(`
    SELECT spec_id, revision, spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC
    LIMIT 1
  `).get(input.taskId, input.storyIndex) as {
    spec_id: string;
    revision: number;
    spec_json: string;
  } | undefined;
  const failureSignature = workflowFailureSignature(input);
  const contractFingerprint = hash(JSON.stringify(spec
    ? { storyIndex: input.storyIndex, contentHash: contractContentFingerprint(spec.spec_json) }
    : { missing: true, storyIndex: input.storyIndex }));
  const repositoryFingerprint = execution.base_commit || null;
  const previous = previousObservation(db, execution.work_item_id, execution.execution_id);
  const sameState = Boolean(
    repositoryFingerprint
    && previous
    && previous.failureSignature === failureSignature
    && previous.repositoryFingerprint === repositoryFingerprint
    && previous.contractFingerprint === contractFingerprint,
  );
  const stagnantCount = sameState ? Math.max(1, previous!.stagnantCount) + 1 : 1;
  const stagnationFingerprint = repositoryFingerprint
    ? hash(JSON.stringify({ failureSignature, repositoryFingerprint, contractFingerprint }))
    : null;
  const observation: StoredObservation = {
    executionId: execution.execution_id,
    workItemId: execution.work_item_id,
    failureSignature,
    repositoryFingerprint,
    contractFingerprint,
    stagnationFingerprint,
    stagnantCount,
    shouldArbitrate: Boolean(stagnationFingerprint && stagnantCount >= 2),
    previousExecutionId: sameState ? previous!.executionId : null,
  };
  db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, 'workflow_failure', 'observation', ?)
    ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING
  `).run(randomUUID(), execution.execution_id, JSON.stringify(observation));
  return observation;
}
