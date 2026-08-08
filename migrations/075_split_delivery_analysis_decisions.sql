PRAGMA foreign_keys = OFF;

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
  workflow_phase TEXT NOT NULL DEFAULT 'impact_scan'
    CHECK(workflow_phase IN (
      'impact_scan',
      'decision_proposal',
      'decision_resolution',
      'delivery_contract',
      'finalize'
    )),
  validated_change_seq INTEGER
);

INSERT INTO delivery_analysis_drafts_next(
  draft_id, unit_key, title, actor, trigger_condition, observable_outcome,
  acceptance, summary, implementation_guidance, workflow_phase, validated_change_seq
)
SELECT draft_id, unit_key, title, actor, trigger_condition, observable_outcome,
       acceptance, summary, implementation_guidance,
       CASE workflow_phase
         WHEN 'decision_tree' THEN 'decision_resolution'
         ELSE workflow_phase
       END,
       validated_change_seq
FROM delivery_analysis_drafts;

DROP TABLE delivery_analysis_drafts;
ALTER TABLE delivery_analysis_drafts_next RENAME TO delivery_analysis_drafts;

ALTER TABLE delivery_analysis_decisions
ADD COLUMN proposed_authority TEXT NOT NULL DEFAULT 'needs_user_input'
  CHECK(proposed_authority IN (
    'upstream', 'project_evidence', 'agent_authority', 'needs_user_input'
  ));

ALTER TABLE delivery_analysis_decisions
ADD COLUMN human_requested INTEGER NOT NULL DEFAULT 0
  CHECK(human_requested IN (0, 1));

UPDATE delivery_analysis_decisions
SET proposed_authority = CASE authority
  WHEN 'user' THEN 'needs_user_input'
  ELSE authority
END;

PRAGMA foreign_keys = ON;
