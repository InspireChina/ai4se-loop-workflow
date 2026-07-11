# Intake

兜底输入目录。

当任务在上下文收集时就 blocked、URL 无法访问、权限不足或类型暂时无法判断时，先在这里创建工作目录，保存原始输入、问题和恢复点。

为避免 agent 反复创建目录，intake 工作目录一旦创建就保持不变。解除阻塞并分类明确后，任务可以继续在原目录推进；最终由 review-agent 根据确认后的 `item_type` 归档到：

```text
.project/features/
.project/bugs/
.project/tech/
```
