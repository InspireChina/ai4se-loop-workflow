CREATE TABLE resource_claims_project_scoped (
  resource_key TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'global',
  owner_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  owner_lane TEXT NOT NULL,
  owner_story_index INTEGER,
  owner_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(resource_key, resource_scope)
);

INSERT INTO resource_claims_project_scoped(
  resource_key, resource_scope, owner_task_id, owner_lane, owner_story_index,
  owner_execution_id, acquired_at, updated_at
)
SELECT resource_key,
       CASE WHEN resource_key = 'code:workspace'
         THEN 'project:' || COALESCE((SELECT project_id FROM tasks WHERE task_id = resource_claims.owner_task_id), 'legacy')
         ELSE 'global'
       END,
       owner_task_id, owner_lane, owner_story_index, owner_execution_id, acquired_at, updated_at
FROM resource_claims;

DROP TABLE resource_claims;

ALTER TABLE resource_claims_project_scoped RENAME TO resource_claims;

CREATE INDEX idx_resource_claims_owner_task ON resource_claims(owner_task_id);
CREATE INDEX idx_resource_claims_owner_execution ON resource_claims(owner_execution_id);
