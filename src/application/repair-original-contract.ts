import type Database from 'better-sqlite3';

type Row = Record<string, unknown>;
type Target = { taskId: string; itemId: string | null; executionId: string | null };
function object(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

/** Freeze facts at the business hold transaction, not at the later repair or
 * verification launch. Executed command receipts are evidence, NOT permission
 * to replace the original oracle with a repairer's proposed shell command. */
export function snapshotRepairOriginalContractInDb(db: Database.Database, target: Target) {
  const item = target.itemId ? db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND item_id = ?')
    .get(target.taskId, target.itemId) as Row | undefined : undefined;
  const execution = target.executionId ? db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? AND execution_id = ?')
    .get(target.taskId, target.executionId) as Row | undefined : undefined;
  // An execution is not authoritative for a different item, even in the same
  // task. Retain that inconsistency as evidence rather than silently rebinding.
  const executionBound = Boolean(execution && (!item || execution.work_item_id === item.item_id
    && execution.story_index === item.story_index));
  const storyIndex = item ? item.story_index : executionBound ? execution!.story_index : null;
  let executedSpec: Row | null = null;
  let executedRequirement: Row | null = null;
  if (executionBound && typeof execution!.input_json === 'string') {
    try {
      const input = object(JSON.parse(execution!.input_json));
      const snapshot = object(input?.contextSnapshot);
      executedSpec = object(object(snapshot?.authoritativeFacts)?.currentDeliverySpec);
      executedRequirement = object(object(snapshot?.authoritativeFacts)?.requirement);
    } catch { /* The unchanged original execution input retains parse failure evidence. */ }
  }
  const specReferenceValid = Boolean(executedSpec && executedSpec.task_id === target.taskId
    && executedSpec.story_index === storyIndex && Number.isInteger(executedSpec.revision) && Number(executedSpec.revision) > 0);
  const spec = storyIndex != null ? (specReferenceValid
    ? db.prepare('SELECT * FROM story_specs WHERE task_id = ? AND story_index = ? AND revision = ?')
      .get(target.taskId, storyIndex, executedSpec!.revision)
    : db.prepare("SELECT * FROM story_specs WHERE task_id = ? AND story_index = ? AND status = 'resolved' ORDER BY revision DESC LIMIT 1")
      .get(target.taskId, storyIndex)) as Row | undefined : undefined;
  const verificationDraft = db.prepare(`SELECT draft.*, chain.definition_version, chain.workflow_phase
    FROM agent_work_drafts draft JOIN command_chain_drafts chain ON chain.draft_id = draft.draft_id
    WHERE draft.task_id = ? AND draft.story_index IS ? AND chain.command_chain_id = 'verification'
      AND draft.agent = 'test-agent'
      ${executionBound && execution!.agent === 'test-agent' ? 'AND (draft.last_execution_id = ? OR draft.terminal_execution_id = ?)' : ''}
    ORDER BY draft.created_at DESC, draft.rowid DESC LIMIT 1`).get(target.taskId, storyIndex,
      ...(executionBound && execution!.agent === 'test-agent' ? [target.executionId, target.executionId] : [])) as Row | undefined;
  const blocks = verificationDraft ? db.prepare(`SELECT artifact_id,block_id,item_key,content_format,content,ordinal
    FROM command_chain_artifact_blocks WHERE draft_id = ? AND artifact_id = 'verification' ORDER BY ordinal,block_id,item_key`)
    .all(verificationDraft.draft_id) as Row[] : [];
  const checks = verificationDraft ? db.prepare(`SELECT check_key,command,command_hash,summary,source_execution_id,source_receipt_key,ordinal
    FROM command_chain_checks WHERE draft_id = ? ORDER BY ordinal,check_key`).all(verificationDraft.draft_id) as Row[] : [];
  // Match the complete receipt identity and validate task/unit/execution scope.
  // A historical receipt with the same key from another execution is not proof.
  const checkedCommands = checks.map(check => {
    const receipts = db.prepare(`SELECT receipt.receipt_id,receipt.kind,receipt.receipt_key,receipt.payload_json,receipt.created_at
      FROM execution_receipts receipt JOIN execution_attempts source ON source.execution_id = receipt.execution_id
      WHERE receipt.execution_id = ? AND receipt.receipt_key = ? AND receipt.kind = 'tool_event' AND source.task_id = ?
        AND source.story_index IS ? AND source.agent = 'test-agent' ORDER BY receipt.rowid`)
      .all(check.source_execution_id, check.source_receipt_key, target.taskId, storyIndex) as Row[];
    return { ...check, receipts, receiptScopeConfirmed: receipts.length > 0 };
  });
  const acceptances = db.prepare(`SELECT acceptance.* FROM acceptances acceptance
    WHERE acceptance.task_id = ? AND acceptance.lifecycle = 'active' AND (
      (? IS NULL AND acceptance.scope_type = 'requirement') OR
      (acceptance.scope_type = 'delivery_unit' AND acceptance.story_index = ?) OR
      EXISTS (SELECT 1 FROM delivery_unit_acceptances link WHERE link.task_id = acceptance.task_id
        AND link.story_index = ? AND link.acceptance_id = acceptance.acceptance_id))
    ORDER BY acceptance.acceptance_key`).all(target.taskId, storyIndex, storyIndex, storyIndex) as Row[];
  const sourceReceipts = executionBound ? db.prepare(`SELECT receipt_id,kind,receipt_key,payload_json,created_at
    FROM execution_receipts WHERE execution_id = ? ORDER BY rowid`).all(target.executionId) as Row[] : [];
  return {
    schemaVersion: 1,
    requirement: { source: executedRequirement ? 'execution-input' : 'fault-time-current',
      authoritativeExecutionRequirement: executedRequirement,
      record: db.prepare('SELECT task_id,title,description,item_type FROM tasks WHERE task_id = ?').get(target.taskId) || null },
    provenance: { taskId: target.taskId, itemId: target.itemId, executionId: target.executionId,
      executionScopeConfirmed: executionBound, storyIndex: storyIndex ?? null },
    deliverySpec: { source: specReferenceValid ? 'execution-reference' : 'fault-time-current',
      executionReference: executedSpec, record: spec || null,
      authoritativeExecutionSpec: specReferenceValid ? executedSpec!.spec ?? null : null,
      referenceResolved: specReferenceValid && Boolean(spec) },
    acceptances,
    verification: { draft: verificationDraft || null, blocks, checkedCommands },
    sourceReceipts,
    authority: 'preserved-original-facts-not-a-runnable-verification-plan',
  };
}
