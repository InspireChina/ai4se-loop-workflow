ALTER TABLE business_analysis_drafts
ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1
CHECK(protocol_version IN (1, 2));

CREATE TABLE business_analysis_module_items (
  draft_id TEXT NOT NULL REFERENCES business_analysis_drafts(draft_id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  item_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, module, item_key)
);

CREATE INDEX idx_business_analysis_module_items_order
ON business_analysis_module_items(draft_id, module, ordinal, item_key);
