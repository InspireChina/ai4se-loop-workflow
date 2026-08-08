PRAGMA foreign_keys = OFF;

CREATE TABLE requirement_context_drafts_next (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  intent TEXT,
  classification TEXT CHECK(classification IS NULL OR classification IN ('feature', 'bug', 'tech', 'other')),
  change_summary TEXT,
  workflow_phase TEXT NOT NULL DEFAULT 'as_is'
    CHECK(workflow_phase IN (
      'as_is',
      'decision_proposal',
      'decision_resolution',
      'to_be',
      'impact_scan',
      'scope',
      'acceptance',
      'finalize'
    )),
  validated_change_seq INTEGER
);

INSERT INTO requirement_context_drafts_next(
  draft_id, intent, classification, change_summary, workflow_phase, validated_change_seq
)
SELECT draft_id, intent, classification, change_summary,
       CASE workflow_phase
         WHEN 'decision_tree' THEN 'decision_resolution'
         ELSE workflow_phase
       END,
       validated_change_seq
FROM requirement_context_drafts;

DROP TABLE requirement_context_drafts;
ALTER TABLE requirement_context_drafts_next RENAME TO requirement_context_drafts;

ALTER TABLE requirement_context_questions
ADD COLUMN proposed_authority TEXT NOT NULL DEFAULT 'needs_user_input'
  CHECK(proposed_authority IN (
    'upstream', 'project_evidence', 'agent_authority', 'needs_user_input'
  ));

ALTER TABLE requirement_context_questions
ADD COLUMN human_requested INTEGER NOT NULL DEFAULT 0
  CHECK(human_requested IN (0, 1));

UPDATE requirement_context_questions
SET proposed_authority = CASE
  WHEN authority = 'agent' THEN 'agent_authority'
  ELSE 'needs_user_input'
END,
human_requested = CASE
  WHEN authority = 'human' AND decision_text IS NULL THEN 1
  ELSE 0
END;

PRAGMA foreign_keys = ON;
