ALTER TABLE agent_work_drafts ADD COLUMN command_chain_id TEXT;

-- 核心交付与反馈 Agents 直接切换到通用 YAML 命令链；旧领域草稿没有迁移或兼容路径。
DELETE FROM agent_work_drafts WHERE draft_type = 'requirement_context';
DELETE FROM agent_work_drafts WHERE draft_type = 'delivery_plan';
DELETE FROM agent_work_drafts WHERE draft_type = 'reproduction';
DELETE FROM agent_work_drafts WHERE draft_type = 'analysis';
DELETE FROM agent_work_drafts WHERE draft_type = 'development';
DELETE FROM agent_work_drafts WHERE draft_type = 'verification';
DELETE FROM agent_work_drafts WHERE draft_type = 'review';
DELETE FROM agent_work_drafts WHERE draft_type = 'feedback';

ALTER TABLE stories DROP COLUMN source_delivery_plan_draft_id;
ALTER TABLE stories ADD COLUMN source_command_chain_draft_id TEXT
  REFERENCES agent_work_drafts(draft_id) ON DELETE SET NULL;

DROP TABLE IF EXISTS requirement_context_phase_transitions;
DROP TABLE IF EXISTS requirement_context_question_dependencies;
DROP TABLE IF EXISTS requirement_context_question_options;
DROP TABLE IF EXISTS requirement_context_questions;
DROP TABLE IF EXISTS requirement_context_item_revisions;
DROP TABLE IF EXISTS requirement_context_acceptance_items;
DROP TABLE IF EXISTS requirement_context_impacts;
DROP TABLE IF EXISTS requirement_context_assertions;
DROP TABLE IF EXISTS requirement_context_scope_items;
DROP TABLE IF EXISTS requirement_context_constraints;
DROP TABLE IF EXISTS requirement_context_drafts;

DROP TABLE IF EXISTS delivery_plan_phase_transitions;
DROP TABLE IF EXISTS delivery_plan_unit_revisions;
DROP TABLE IF EXISTS delivery_plan_unit_dependencies;
DROP TABLE IF EXISTS delivery_plan_unit_source_links;
DROP TABLE IF EXISTS delivery_plan_source_items;
DROP TABLE IF EXISTS delivery_plan_units;
DROP TABLE IF EXISTS delivery_plan_drafts;

DROP TABLE IF EXISTS reproduction_question_options;
DROP TABLE IF EXISTS reproduction_questions;
DROP TABLE IF EXISTS reproduction_hypotheses;
DROP TABLE IF EXISTS reproduction_evidence;
DROP TABLE IF EXISTS reproduction_steps;
DROP TABLE IF EXISTS reproduction_drafts;

DROP TABLE IF EXISTS delivery_analysis_phase_transitions;
DROP TABLE IF EXISTS delivery_analysis_decision_dependencies;
DROP TABLE IF EXISTS delivery_analysis_impacts;
DROP TABLE IF EXISTS delivery_analysis_decision_options;
DROP TABLE IF EXISTS delivery_analysis_decisions;
DROP TABLE IF EXISTS delivery_analysis_guardrails;
DROP TABLE IF EXISTS delivery_analysis_verification_focus;
DROP TABLE IF EXISTS delivery_analysis_upstream_dependencies;
DROP TABLE IF EXISTS delivery_analysis_source_items;
DROP TABLE IF EXISTS delivery_analysis_drafts;

DROP TABLE IF EXISTS development_phase_transitions;
DROP TABLE IF EXISTS development_recovery_resolutions;
DROP TABLE IF EXISTS development_runtime_inputs;
DROP TABLE IF EXISTS development_risks;
DROP TABLE IF EXISTS development_checks;
DROP TABLE IF EXISTS development_criteria;
DROP TABLE IF EXISTS development_drafts;

DROP TABLE IF EXISTS verification_phase_transitions;
DROP TABLE IF EXISTS verification_results;
DROP TABLE IF EXISTS verification_plan_scenarios;
DROP TABLE IF EXISTS verification_drafts;

DROP TABLE IF EXISTS review_phase_transitions;
DROP TABLE IF EXISTS review_forward_unit_dependencies;
DROP TABLE IF EXISTS review_forward_unit_gaps;
DROP TABLE IF EXISTS review_forward_units;
DROP TABLE IF EXISTS review_reconciliation_evidence;
DROP TABLE IF EXISTS review_reconciliations;
DROP TABLE IF EXISTS review_gaps;
DROP TABLE IF EXISTS review_required_subjects;
DROP TABLE IF EXISTS review_sections;
DROP TABLE IF EXISTS review_drafts;

DROP TABLE IF EXISTS feedback_draft_question_options;
DROP TABLE IF EXISTS feedback_draft_questions;
DROP TABLE IF EXISTS feedback_draft_acceptance;
DROP TABLE IF EXISTS feedback_draft_group_units;
DROP TABLE IF EXISTS feedback_draft_group_comments;
DROP TABLE IF EXISTS feedback_draft_groups;
DROP TABLE IF EXISTS feedback_draft_evidence;
DROP TABLE IF EXISTS feedback_drafts;

CREATE TABLE command_chain_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  command_chain_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  workflow_phase TEXT NOT NULL,
  validated_change_seq INTEGER
);

CREATE TABLE command_chain_artifact_blocks (
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  item_key TEXT NOT NULL DEFAULT '',
  content_format TEXT NOT NULL CHECK(content_format IN ('markdown', 'yaml', 'text')),
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, artifact_id, block_id, item_key)
);

CREATE TABLE command_chain_decisions (
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  tree_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed', 'needs_user_input', 'resolved')),
  selected_option_id TEXT,
  authority TEXT,
  decision_text TEXT,
  rationale TEXT,
  evidence TEXT,
  human_requested INTEGER NOT NULL DEFAULT 0 CHECK(human_requested IN (0, 1)),
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, tree_id, decision_key)
);

CREATE TABLE command_chain_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE command_chain_checks (
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  command TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  source_receipt_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, check_key)
);

CREATE TABLE command_chain_runtime_inputs (
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, request_key)
);

CREATE INDEX idx_command_chain_artifact_blocks_draft
  ON command_chain_artifact_blocks(draft_id, artifact_id, block_id, ordinal);
CREATE INDEX idx_command_chain_decisions_draft
  ON command_chain_decisions(draft_id, tree_id, ordinal);
CREATE INDEX idx_command_chain_checks_draft
  ON command_chain_checks(draft_id, ordinal);
CREATE INDEX idx_command_chain_runtime_inputs_draft
  ON command_chain_runtime_inputs(draft_id, ordinal);
