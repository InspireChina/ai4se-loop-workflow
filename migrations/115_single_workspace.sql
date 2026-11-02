CREATE TRIGGER dji_one_workspace_insert BEFORE INSERT ON projects
WHEN NEW.project_id <> 'PRJ-default' OR (EXISTS(SELECT 1 FROM projects) AND NOT EXISTS(SELECT 1 FROM projects WHERE project_id=NEW.project_id))
BEGIN
  SELECT RAISE(ABORT, 'DJI 仅支持当前实例的唯一工作目录');
END;
CREATE TRIGGER dji_one_workspace_update BEFORE UPDATE ON projects
WHEN NEW.project_id <> OLD.project_id OR NEW.is_default <> 1 OR NEW.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DJI 不支持切换、删除或新增项目');
END;
CREATE TRIGGER dji_one_workspace_delete BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'DJI 不支持删除工作目录');
END;
