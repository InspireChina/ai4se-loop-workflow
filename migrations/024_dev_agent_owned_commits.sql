UPDATE tasks
SET run_state = 'runnable',
    blocked_reason = NULL,
    next_step = 'Git 提交已交由开发实现 Agent 自主处理',
    updated_at = CURRENT_TIMESTAMP
WHERE run_state = 'waiting_for_git_input';

UPDATE git_commit_resolution_requests
SET status = 'superseded'
WHERE status IN ('pending', 'answered');

DELETE FROM project_settings
WHERE setting_key = 'git_commit_message_template';
