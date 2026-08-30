ALTER TABLE agent_configuration_documents
ADD COLUMN system_managed INTEGER NOT NULL DEFAULT 0
  CHECK(system_managed IN (0, 1));

-- 002-005 发布前生成的默认文档没有显式 managed 标记。
-- revision=1 从未被编辑；下方 hash 是本次迁移已升级的 Requirement Context 基线。
UPDATE agent_configuration_documents
SET system_managed = 1
WHERE configuration_id IN (
  SELECT configuration_id FROM agent_configuration_sets WHERE name = '默认配置'
)
AND (
  revision = 1
  OR content_hash = '561dbbe4feba039976e1c064f71a166f19b48a432822eb43d7e4ca1c107c53b0'
);
