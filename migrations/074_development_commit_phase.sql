PRAGMA foreign_keys = OFF;

CREATE TABLE development_drafts_next (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  workflow_phase TEXT NOT NULL DEFAULT 'implement'
    CHECK(workflow_phase IN ('implement', 'review', 'developer_verify', 'commit', 'finalize')),
  validated_change_seq INTEGER,
  review_result TEXT CHECK(review_result IN ('pass', 'needs_changes')),
  review_summary TEXT,
  review_evidence TEXT
);

INSERT INTO development_drafts_next(
  draft_id, workflow_phase, validated_change_seq,
  review_result, review_summary, review_evidence
)
SELECT draft_id, workflow_phase, validated_change_seq,
       review_result, review_summary, review_evidence
FROM development_drafts;

DROP TABLE development_drafts;

ALTER TABLE development_drafts_next RENAME TO development_drafts;

PRAGMA foreign_keys = ON;
