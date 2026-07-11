# Loop Control README

这个目录是个人 `/loop` 的控制台。日常主要改一个输入文件：

- `inbox.md`：临时丢给 `/loop` 的单个卡片、Bug 或需求片段。

`loopctl pipeline-all` 会先检查 `inbox.md` 的 MD5。只有 inbox 有变化时，它才会返回 `source-agent` 委派；`source-agent` 收到委派后会读取已处理 URL 集合，如果 `inbox.md` 中的新 URL 已经存在于 `loop.db.tasks`，会直接跳过，不重复入库。

## Inbox 使用方式

把临时输入追加到 `.project/_loop/inbox.md` 的 `## 新输入` 下面即可，不需要手动改 SQLite。

推荐写法：

- 有 URL 的输入优先提供 URL，`source-agent` 会按 URL 判断是否已处理。
- 没有 URL 的输入也可以放进 inbox，但无法强幂等，可能需要人工判断是否重复。
- 不要删除原始内容；如果需要标记处理结果，让 `source-agent` 追加处理记录。

## Example：卡墙需求

```md
### CARD-123 项目列表支持按 PIC 筛选

- 链接：https://example.com/cards/CARD-123
- 来源：卡墙
- 类型：业务需求
- 优先级：P1
- 当前状态：待开发
- 摘要：项目 PIC 希望在项目列表中按 PIC 筛选项目，方便快速定位自己负责的项目。
- 备注：请收集卡片正文、评论和图片附件后进入 in plan。
```

预期处理：

- 如果 URL 不存在于任务中心，`source-agent` 调用 `task-ingest` 入库为 `backlog`。
- 如果 URL 已存在，`source-agent` 记录 `skipped existing URL`，不重复入库。

## Example：Bug

```md
### BUG-456 任务工作台完成按钮点击后状态未刷新

- 链接：https://example.com/bugs/BUG-456
- 来源：Bug 系统
- 类型：Bug
- 严重程度：S2
- 复现环境：测试环境，Chrome
- 复现步骤：
- 1. 打开任务工作台。
- 2. 选择一个未完成任务。
- 3. 点击完成按钮。
- 实际结果：按钮点击后页面仍显示未完成。
- 期望结果：任务状态刷新为已完成，列表状态同步更新。
- 备注：请先进入 in repro，不要直接开发。
```

预期处理：

- `source-agent` 入库为 `backlog`。
- `backlog-agent` 收集上下文后识别为 Bug，并进入 `in repro`。

## Example：无 URL 临时输入

```md
### 临时需求：项目详情页展示需求单数量

- 来源：人工输入
- 类型：业务需求
- 优先级：P2
- 摘要：项目详情页需要展示当前项目下需求单数量，帮助 PIC 快速判断项目规模。
- 备注：当前没有卡片 URL，请先作为 manual inbox 进入 backlog，并在后续 story 分析阶段确认是否需要补卡。
```

预期处理：

- `source-agent` 可以调用 `task-add` 入库。
- 因为没有 URL，无法强幂等，风险中应记录“manual inbox 无 URL，可能重复入库”。

## 使用建议

- 新增需求或 Bug 不频繁时，直接把 URL 粘到 `inbox.md`。
- 不做实时外部扫描；如果你想处理某张卡，就把它放进 inbox。
- 如果同一个 URL 已经处理过，source-agent 会跳过。
- blocked 任务不会每轮自动回派 agent。`loopctl` 会在工作目录生成 `block.md` 并记录恢复状态，`/loop` 通过 `block-list` 汇总提醒。处理完阻塞后，执行 `python scripts/loop/loopctl.py block-release <TASK_ID>`，CLI 会恢复原状态，下一轮先回派原责任 agent。
- analyst-agent 阻塞时，在当前 Story 的 `90_analysis_questions.md` 修改 `Analysis Decision`：`continue` 表示继续澄清，`confirmed` 才允许完成分析。
- review-agent 阻塞时，在当前任务的 `06_review.md` 修改 `Review Decision`：`changes_requested` 表示驳回，`approved` 才允许归档并进入 done。review 阻塞期间仍占用代码槽。
