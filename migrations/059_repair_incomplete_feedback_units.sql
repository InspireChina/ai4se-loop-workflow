CREATE TEMP TABLE legacy_incomplete_feedback_units (
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY(task_id, story_index, group_id)
);

INSERT INTO legacy_incomplete_feedback_units(task_id, story_index, group_id)
SELECT story.task_id, story.story_index, link.group_id
FROM stories story
JOIN tasks task ON task.task_id = story.task_id
JOIN feedback_group_delivery_units link
  ON link.task_id = story.task_id
 AND link.story_index = story.story_index
JOIN feedback_groups feedback_group ON feedback_group.group_id = link.group_id
WHERE story.origin_type IN (
    'feedback_behavior', 'feedback_bug', 'feedback_scope', 'feedback_technical'
  )
  AND feedback_group.work_type IN (
    'behavior_change', 'bug', 'scope_addition', 'technical_change'
  )
  AND story.story_index > task.analysis_index
  AND (
    NULLIF(TRIM(story.unit_key), '') IS NULL
    OR NULLIF(TRIM(story.actor), '') IS NULL
    OR NULLIF(TRIM(story.trigger_condition), '') IS NULL
    OR NULLIF(TRIM(story.observable_outcome), '') IS NULL
    OR NULLIF(TRIM(story.acceptance), '') IS NULL
  );

UPDATE feedback_groups
SET status = 'waiting_for_plan', updated_at = CURRENT_TIMESTAMP
WHERE group_id IN (
  SELECT DISTINCT group_id FROM legacy_incomplete_feedback_units
);

DELETE FROM stories
WHERE (task_id, story_index) IN (
  SELECT task_id, story_index FROM legacy_incomplete_feedback_units
);

UPDATE tasks
SET total_stories = (
      SELECT COALESCE(MAX(story_index), 0)
      FROM stories
      WHERE stories.task_id = tasks.task_id
    ),
    agile_status = 'in feedback',
    current_subagent = 'story-splitter-agent',
    run_state = 'runnable',
    blocked_reason = NULL,
    resume_status = NULL,
    resume_pending = 0,
    next_step = '已清理旧版残缺反馈单元，等待交付规划 Agent 重新形成完整契约',
    last_actor = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE task_id IN (
  SELECT DISTINCT task_id FROM legacy_incomplete_feedback_units
);

UPDATE task_lanes
SET status = 'completed',
    current_agent = NULL,
    current_story_index = NULL,
    blocked_reason = NULL,
    resume_pending = 0,
    ready_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE lane = 'analysis'
  AND task_id IN (
    SELECT DISTINCT task_id FROM legacy_incomplete_feedback_units
  );

INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
SELECT lower(hex(randomblob(16))), task_id, 'system',
       'IncompleteFeedbackUnitRepaired',
       '清理旧版直接创建的残缺反馈单元，重新交给交付规划 Agent'
FROM (
  SELECT DISTINCT task_id FROM legacy_incomplete_feedback_units
);

DROP TABLE legacy_incomplete_feedback_units;
