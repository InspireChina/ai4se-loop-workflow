CREATE TABLE delivery_analysis_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  observable_outcome TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  walkthrough TEXT,
  change_boundary TEXT
);

CREATE TABLE delivery_analysis_source_items (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('change', 'preserve', 'technical', 'acceptance')),
  content TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, source_key)
);

CREATE TABLE delivery_analysis_upstream_dependencies (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  story_index INTEGER NOT NULL,
  unit_key TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, story_index)
);

CREATE TABLE delivery_analysis_facts (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, fact_key)
);

CREATE TABLE delivery_analysis_scenarios (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  scenario_key TEXT NOT NULL,
  situation TEXT NOT NULL,
  response TEXT NOT NULL,
  observable_result TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, scenario_key)
);

CREATE TABLE delivery_analysis_decisions (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  impact TEXT NOT NULL,
  authority TEXT NOT NULL CHECK(authority IN (
    'upstream', 'user', 'project_evidence', 'agent_authority', 'needs_user_input'
  )),
  status TEXT NOT NULL CHECK(status IN ('resolved', 'needs_user_input')),
  selected_option_id TEXT,
  decision_text TEXT,
  rationale TEXT,
  evidence TEXT,
  recommendation_option_id TEXT,
  recommendation_reason TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key)
);

CREATE TABLE delivery_analysis_decision_options (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  option_id TEXT NOT NULL,
  label TEXT NOT NULL,
  consequence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key, option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE CASCADE
);

CREATE TABLE delivery_analysis_decision_dependencies (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  depends_on_decision_key TEXT NOT NULL,
  PRIMARY KEY(draft_id, decision_key, depends_on_decision_key),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE CASCADE,
  FOREIGN KEY(draft_id, depends_on_decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE CASCADE
);

CREATE TABLE delivery_analysis_boundaries (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  boundary_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('allowed_change', 'preserve', 'excluded')),
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, boundary_key)
);

CREATE TABLE delivery_analysis_criteria (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL,
  description TEXT NOT NULL,
  oracle TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, criterion_key)
);

CREATE TABLE delivery_analysis_verification_steps (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  verification_key TEXT NOT NULL,
  criterion_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('command', 'browser', 'inspection')),
  instruction TEXT NOT NULL,
  command TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, verification_key),
  FOREIGN KEY(draft_id, criterion_key)
    REFERENCES delivery_analysis_criteria(draft_id, criterion_key)
    ON DELETE CASCADE
);

CREATE TABLE delivery_analysis_external_dependencies (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  dependency_key TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, dependency_key)
);

CREATE TABLE delivery_analysis_scope_gaps (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  gap_key TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('absorbed', 'new_delivery', 'needs_user_input')),
  resolution TEXT,
  decision_key TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, gap_key),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE SET NULL
);

CREATE TABLE delivery_analysis_source_coverage (
  draft_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('scenario', 'decision', 'criterion', 'boundary')),
  target_key TEXT NOT NULL,
  PRIMARY KEY(draft_id, source_key, target_kind, target_key),
  FOREIGN KEY(draft_id, source_key)
    REFERENCES delivery_analysis_source_items(draft_id, source_key)
    ON DELETE CASCADE
);

-- 本次协议尚未上线，不迁移旧方案分析草稿。清除旧模型，避免运行时同时存在
-- analysis 与 delivery-analysis 两套可被误认为有效的写入协议。
DELETE FROM agent_work_drafts WHERE draft_type = 'analysis';
DROP TABLE analysis_decision_options;
DROP TABLE analysis_verification_steps;
DROP TABLE analysis_acceptance_criteria;
DROP TABLE analysis_dependencies;
DROP TABLE analysis_budget_items;
DROP TABLE analysis_scope_items;
DROP TABLE analysis_behaviors;
DROP TABLE analysis_decisions;
DROP TABLE analysis_drafts;
