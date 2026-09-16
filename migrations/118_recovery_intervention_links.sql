-- Legacy Recovery rows become read-only compatibility snapshots when a task
-- adopts the native engine. Application adoption materializes their complete
-- context atomically; rows written by the still-legacy engine remain usable.
ALTER TABLE recovery_items ADD COLUMN intervention_id TEXT REFERENCES interventions(intervention_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_recovery_items_intervention ON recovery_items(intervention_id)
  WHERE intervention_id IS NOT NULL;
CREATE INDEX idx_execution_receipts_recovery_claim ON execution_receipts(receipt_key, created_at)
  WHERE kind = 'recovery_claim';
