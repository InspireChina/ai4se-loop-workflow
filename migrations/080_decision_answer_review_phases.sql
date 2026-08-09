PRAGMA foreign_keys = OFF;

CREATE TABLE requirement_context_drafts_next (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  intent TEXT,
  classification TEXT CHECK(classification IS NULL OR classification IN ('feature', 'bug', 'tech', 'other')),
  change_summary TEXT,
  answer_review TEXT,
  workflow_phase TEXT NOT NULL DEFAULT 'as_is'
    CHECK(workflow_phase IN (
      'as_is',
      'decision_proposal',
      'decision_resolution',
      'answer_review',
      'to_be',
      'impact_scan',
      'scope',
      'acceptance',
      'finalize'
    )),
  validated_change_seq INTEGER
);

INSERT INTO requirement_context_drafts_next(
  draft_id, intent, classification, change_summary, answer_review,
  workflow_phase, validated_change_seq
)
SELECT draft_id, intent, classification, change_summary, NULL,
       workflow_phase, validated_change_seq
FROM requirement_context_drafts;

DROP TABLE requirement_context_drafts;
ALTER TABLE requirement_context_drafts_next RENAME TO requirement_context_drafts;

CREATE TABLE delivery_analysis_drafts_next (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  observable_outcome TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  summary TEXT,
  implementation_guidance TEXT,
  answer_review TEXT,
  workflow_phase TEXT NOT NULL DEFAULT 'impact_scan'
    CHECK(workflow_phase IN (
      'impact_scan',
      'decision_proposal',
      'decision_resolution',
      'answer_review',
      'delivery_contract',
      'finalize'
    )),
  validated_change_seq INTEGER
);

INSERT INTO delivery_analysis_drafts_next(
  draft_id, unit_key, title, actor, trigger_condition, observable_outcome,
  acceptance, summary, implementation_guidance, answer_review,
  workflow_phase, validated_change_seq
)
SELECT draft_id, unit_key, title, actor, trigger_condition, observable_outcome,
       acceptance, summary, implementation_guidance, NULL,
       workflow_phase, validated_change_seq
FROM delivery_analysis_drafts;

DROP TABLE delivery_analysis_drafts;
ALTER TABLE delivery_analysis_drafts_next RENAME TO delivery_analysis_drafts;

PRAGMA foreign_keys = ON;
