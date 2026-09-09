CREATE TRIGGER IF NOT EXISTS trg_schedules_project_immutable_after_materialization
BEFORE UPDATE OF project_id ON scheduled_requirement_plans
WHEN NEW.project_id <> OLD.project_id
  AND (
    OLD.last_task_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM scheduled_requirement_occurrences occurrence
      WHERE occurrence.plan_id = OLD.plan_id AND occurrence.task_id IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, '已生成需求的定时计划不能切换项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedules_last_task_same_project_insert
BEFORE INSERT ON scheduled_requirement_plans
WHEN NEW.last_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.task_id = NEW.last_task_id AND task.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, '定时计划最近生成的需求必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedules_last_task_same_project_update
BEFORE UPDATE OF project_id, last_task_id ON scheduled_requirement_plans
WHEN NEW.last_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.task_id = NEW.last_task_id AND task.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, '定时计划最近生成的需求必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedule_occurrences_same_project_insert
BEFORE INSERT ON scheduled_requirement_occurrences
WHEN NEW.task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM scheduled_requirement_plans plan
    JOIN tasks task ON task.task_id = NEW.task_id
    WHERE plan.plan_id = NEW.plan_id AND plan.project_id = task.project_id
  )
BEGIN
  SELECT RAISE(ABORT, '定时计划生成记录的需求必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedule_occurrences_same_project_update
BEFORE UPDATE OF plan_id, task_id ON scheduled_requirement_occurrences
WHEN NEW.task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM scheduled_requirement_plans plan
    JOIN tasks task ON task.task_id = NEW.task_id
    WHERE plan.plan_id = NEW.plan_id AND plan.project_id = task.project_id
  )
BEGIN
  SELECT RAISE(ABORT, '定时计划生成记录的需求必须属于同一项目');
END;

UPDATE agent_evolution_runs
SET project_id = (
  SELECT task.project_id
  FROM execution_attempts execution
  JOIN tasks task ON task.task_id = execution.task_id
  WHERE execution.execution_id = agent_evolution_runs.execution_id
)
WHERE project_id IS NULL
   OR project_id <> (
     SELECT task.project_id
     FROM execution_attempts execution
     JOIN tasks task ON task.task_id = execution.task_id
     WHERE execution.execution_id = agent_evolution_runs.execution_id
   );

CREATE TRIGGER IF NOT EXISTS trg_agent_evolution_runs_same_project_insert
BEFORE INSERT ON agent_evolution_runs
WHEN NEW.project_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM execution_attempts execution
    JOIN tasks task ON task.task_id = execution.task_id
    WHERE execution.execution_id = NEW.execution_id AND task.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Agent 演化运行必须属于 execution 对应项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_evolution_runs_same_project_update
BEFORE UPDATE OF project_id, execution_id ON agent_evolution_runs
WHEN NEW.project_id IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM execution_attempts execution
    JOIN tasks task ON task.task_id = execution.task_id
    WHERE execution.execution_id = NEW.execution_id AND task.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Agent 演化运行必须属于 execution 对应项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_observation_occurrences_same_project_insert
BEFORE INSERT ON project_agent_observation_occurrences
WHEN NOT EXISTS (
  SELECT 1
  FROM project_agent_observations observation
  JOIN execution_attempts execution ON execution.execution_id = NEW.execution_id
  JOIN tasks task ON task.task_id = NEW.task_id
  WHERE observation.observation_id = NEW.observation_id
    AND observation.project_id = task.project_id
    AND execution.task_id = task.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent 观察 occurrence 必须属于同一项目和需求');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_observation_occurrences_same_project_update
BEFORE UPDATE OF observation_id, execution_id, task_id ON project_agent_observation_occurrences
WHEN NOT EXISTS (
  SELECT 1
  FROM project_agent_observations observation
  JOIN execution_attempts execution ON execution.execution_id = NEW.execution_id
  JOIN tasks task ON task.task_id = NEW.task_id
  WHERE observation.observation_id = NEW.observation_id
    AND observation.project_id = task.project_id
    AND execution.task_id = task.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent 观察 occurrence 必须属于同一项目和需求');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_observation_comments_same_project_insert
BEFORE INSERT ON project_agent_observation_comment_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM project_agent_observations observation
  JOIN document_comments comment ON comment.comment_id = NEW.comment_id
  JOIN tasks task ON task.task_id = comment.task_id
  WHERE observation.observation_id = NEW.observation_id
    AND observation.project_id = task.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent 观察评论证据必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_observation_comments_same_project_update
BEFORE UPDATE OF observation_id, comment_id ON project_agent_observation_comment_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM project_agent_observations observation
  JOIN document_comments comment ON comment.comment_id = NEW.comment_id
  JOIN tasks task ON task.task_id = comment.task_id
  WHERE observation.observation_id = NEW.observation_id
    AND observation.project_id = task.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'Agent 观察评论证据必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_observations_project_update_integrity
BEFORE UPDATE OF project_id ON project_agent_observations
WHEN EXISTS (
  SELECT 1
  FROM project_agent_observation_occurrences occurrence
  JOIN tasks task ON task.task_id = occurrence.task_id
  WHERE occurrence.observation_id = OLD.observation_id AND task.project_id <> NEW.project_id
)
OR EXISTS (
  SELECT 1
  FROM project_agent_observation_comment_evidence evidence
  JOIN document_comments comment ON comment.comment_id = evidence.comment_id
  JOIN tasks task ON task.task_id = comment.task_id
  WHERE evidence.observation_id = OLD.observation_id AND task.project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, '不能把已有证据的 Agent 观察切换到其他项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_project_update_schedule_integrity
BEFORE UPDATE OF project_id ON tasks
WHEN EXISTS (
  SELECT 1 FROM scheduled_requirement_plans plan
  WHERE plan.last_task_id = OLD.task_id AND plan.project_id <> NEW.project_id
)
OR EXISTS (
  SELECT 1
  FROM scheduled_requirement_occurrences occurrence
  JOIN scheduled_requirement_plans plan ON plan.plan_id = occurrence.plan_id
  WHERE occurrence.task_id = OLD.task_id AND plan.project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, '不能把定时计划历史需求切换到其他项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_project_update_evolution_integrity
BEFORE UPDATE OF project_id ON tasks
WHEN EXISTS (
  SELECT 1
  FROM execution_attempts execution
  JOIN agent_evolution_runs evolution ON evolution.execution_id = execution.execution_id
  WHERE execution.task_id = OLD.task_id AND evolution.project_id <> NEW.project_id
)
OR EXISTS (
  SELECT 1
  FROM project_agent_observation_occurrences occurrence
  JOIN project_agent_observations observation ON observation.observation_id = occurrence.observation_id
  WHERE occurrence.task_id = OLD.task_id AND observation.project_id <> NEW.project_id
)
OR EXISTS (
  SELECT 1
  FROM document_comments comment
  JOIN project_agent_observation_comment_evidence evidence ON evidence.comment_id = comment.comment_id
  JOIN project_agent_observations observation ON observation.observation_id = evidence.observation_id
  WHERE comment.task_id = OLD.task_id AND observation.project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, '不能把已有 Agent 演化证据的需求切换到其他项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_attempts_task_update_evolution_integrity
BEFORE UPDATE OF task_id ON execution_attempts
WHEN EXISTS (
  SELECT 1
  FROM agent_evolution_runs evolution
  JOIN tasks task ON task.task_id = NEW.task_id
  WHERE evolution.execution_id = OLD.execution_id AND evolution.project_id <> task.project_id
)
OR EXISTS (
  SELECT 1
  FROM project_agent_observation_occurrences occurrence
  JOIN project_agent_observations observation ON observation.observation_id = occurrence.observation_id
  JOIN tasks task ON task.task_id = NEW.task_id
  WHERE occurrence.execution_id = OLD.execution_id
    AND (occurrence.task_id <> NEW.task_id OR observation.project_id <> task.project_id)
)
BEGIN
  SELECT RAISE(ABORT, '不能把已有 Agent 演化证据的 execution 切换到其他需求');
END;

CREATE TRIGGER IF NOT EXISTS trg_document_comments_task_update_evolution_integrity
BEFORE UPDATE OF task_id ON document_comments
WHEN EXISTS (
  SELECT 1
  FROM project_agent_observation_comment_evidence evidence
  JOIN project_agent_observations observation ON observation.observation_id = evidence.observation_id
  JOIN tasks task ON task.task_id = NEW.task_id
  WHERE evidence.comment_id = OLD.comment_id AND observation.project_id <> task.project_id
)
BEGIN
  SELECT RAISE(ABORT, '不能把已有 Agent 演化证据的评论切换到其他项目');
END;
