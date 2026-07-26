-- Do It Twice 是交付分析 Agent 的思考方法，不是需要逐项持久化的表单。
-- 当前协议尚未发布，直接清除无业务价值的重型草稿，收敛为影响、决策与交接。
DELETE FROM agent_work_drafts WHERE draft_type = 'analysis';

DROP TABLE delivery_analysis_source_coverage;
DROP TABLE delivery_analysis_scope_gaps;
DROP TABLE delivery_analysis_external_dependencies;
DROP TABLE delivery_analysis_verification_steps;
DROP TABLE delivery_analysis_criteria;
DROP TABLE delivery_analysis_boundaries;
DROP TABLE delivery_analysis_decision_dependencies;
DROP TABLE delivery_analysis_decision_options;
DROP TABLE delivery_analysis_decisions;
DROP TABLE delivery_analysis_scenarios;
DROP TABLE delivery_analysis_facts;
DROP TABLE delivery_analysis_upstream_dependencies;
DROP TABLE delivery_analysis_source_items;
DROP TABLE delivery_analysis_drafts;

CREATE TABLE delivery_analysis_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  observable_outcome TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  summary TEXT,
  implementation_guidance TEXT
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

CREATE TABLE delivery_analysis_decisions (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  decision_type TEXT NOT NULL CHECK(decision_type IN ('business', 'technical')),
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

CREATE TABLE delivery_analysis_impacts (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  impact_key TEXT NOT NULL,
  area TEXT NOT NULL,
  finding TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN (
    'change', 'preserve', 'exclude', 'needs_decision'
  )),
  evidence TEXT NOT NULL,
  decision_key TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, impact_key),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE SET NULL
);

CREATE TABLE delivery_analysis_guardrails (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  guardrail_key TEXT NOT NULL,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, guardrail_key)
);

CREATE TABLE delivery_analysis_verification_focus (
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  focus_key TEXT NOT NULL,
  expected TEXT NOT NULL,
  oracle TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, focus_key)
);
