ALTER TABLE questions
  ADD COLUMN intervention_id TEXT REFERENCES interventions(intervention_id) ON DELETE SET NULL;

ALTER TABLE runtime_input_requests
  ADD COLUMN intervention_id TEXT REFERENCES interventions(intervention_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_intervention
  ON questions(intervention_id) WHERE intervention_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_inputs_intervention
  ON runtime_input_requests(intervention_id) WHERE intervention_id IS NOT NULL;

INSERT OR IGNORE INTO interventions(
  intervention_id, task_id, item_id, dedupe_key, status,
  resolver_strategy, authority, requested_by, summary,
  context_json, context_hash, resolution, resolved_by,
  created_at, updated_at, resolved_at
)
SELECT
  'INT-Q-' || question.question_id,
  question.task_id,
  NULL,
  'question:' || question.question_id,
  CASE question.status
    WHEN 'pending' THEN 'awaiting_human'
    WHEN 'answered' THEN 'resolved'
    WHEN 'resolved' THEN 'resolved'
    WHEN 'not_applicable' THEN 'superseded'
    WHEN 'superseded' THEN 'superseded'
    ELSE 'pending'
  END,
  'human_only',
  'standard',
  COALESCE(question.source_agent, 'human'),
  question.title,
  '{"legacyQuestionId":"' || question.question_id || '"}',
  'legacy-question:' || question.question_id,
  question.answer,
  CASE WHEN question.status IN ('answered', 'resolved') THEN 'human' END,
  question.created_at,
  question.updated_at,
  CASE WHEN question.status IN ('answered', 'resolved') THEN question.updated_at END
FROM questions question;

UPDATE questions
SET intervention_id = 'INT-Q-' || question_id
WHERE intervention_id IS NULL;

UPDATE runtime_input_requests
SET intervention_id = (
  SELECT job.intervention_id
  FROM verification_assistance_jobs job
  WHERE job.request_id = runtime_input_requests.request_id
)
WHERE intervention_id IS NULL
  AND EXISTS (
    SELECT 1 FROM verification_assistance_jobs job
    WHERE job.request_id = runtime_input_requests.request_id
      AND job.intervention_id IS NOT NULL
  );

INSERT OR IGNORE INTO interventions(
  intervention_id, task_id, item_id, dedupe_key, status,
  resolver_strategy, authority, requested_by, source_execution_id,
  summary, context_json, context_hash, resolution, resolved_by,
  created_at, updated_at, resolved_at
)
SELECT
  'INT-RI-' || request.request_id,
  request.task_id,
  NULL,
  'runtime-input:' || request.request_id,
  CASE request.status
    WHEN 'pending' THEN 'awaiting_human'
    WHEN 'answered' THEN 'resolved'
    WHEN 'resolved' THEN 'resolved'
    ELSE 'superseded'
  END,
  'human_only',
  'standard',
  request.source_agent,
  request.source_execution_id,
  request.title,
  '{"legacyRuntimeInputId":"' || request.request_id || '"}',
  'legacy-runtime-input:' || request.request_id,
  request.answer,
  CASE WHEN request.status IN ('answered', 'resolved') THEN 'human' END,
  request.created_at,
  request.updated_at,
  request.resolved_at
FROM runtime_input_requests request
WHERE request.intervention_id IS NULL;

UPDATE runtime_input_requests
SET intervention_id = 'INT-RI-' || request_id
WHERE intervention_id IS NULL;
