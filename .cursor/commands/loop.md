# /loop

这是手动调试入口，不是产品化 App 的主要运行路径。

产品化运行路径由 App/runner 调度：

1. App 创建 run lease。
2. App 调用 `pipeline-all` / `createLoopDispatch` 得到本轮 delegation。
3. runner 按 delegation 逐个启动 Cursor CLI。
4. 每次 Cursor CLI 只执行一个明确的 agent / task / story / pipeline。

因此，手动使用 `/loop` 时也必须遵守同样边界：不要让一个总控 agent 自行分发多个 pipeline agent。当前 agent 可以使用辅助 subagent 收集上下文或做局部分析，但辅助工作必须限制在当前 delegation 内。

## 单步执行原则

所有状态读取和写入都必须通过：

```bash
python scripts/loop/loopctl.py ...
```

先获取本轮委派：

```bash
RUN_TOKEN=$(python scripts/loop/loopctl.py run-begin --lease-minutes 120)
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN" --format jsonl
```

然后选择其中一行 JSONL，只执行这一行里的 `agent`、`task_id`、`story_index`、`pipeline` 和 `description`。不要处理其他行。

允许当前 agent 使用辅助 subagent，但边界是：

- 辅助 subagent 只能服务当前 delegation。
- 辅助 subagent 不得处理其他 Task、其他 Story 或其他 pipeline agent 的职责。
- 辅助 subagent 不得推进 Task 状态；最终 `document-upsert`、`question-add`、`task-update` 必须由当前 agent 负责。

## Agent 职责

- `backlog-agent`：通过 `task-context` 收集上下文，必要时执行 `task-context-init --actor backlog-agent`，再用 `task-update` 推进到 `in plan`、`in repro` 或 `blocked`。
- `story-splitter-agent`：拆分 Story，使用 `story-add --actor story-splitter-agent` 创建 Story；拆分完成后用 `task-update` 推进状态。
- `analyst-agent`：处理指定 Story 的需求和方案；结论用 `document-upsert` 写入数据库；需要人工确认时调用 `question-add --json`。
- `repro-agent`：复现 Bug，并用 `document-upsert` 写入复现材料。
- `dev-agent`：实现指定 Story，完成后推进 `dev_index`。
- `test-agent`：黑盒测试指定 Story，把测试结果用 `document-upsert` 写入数据库，完成后推进 `test_index` 或回流。
- `review-agent`：审查完整 Task，把 review 结论用 `document-upsert` 写入数据库；需要人工批准时调用 `question-add --json`。

## 数据库上下文

读取上下文：

```bash
python scripts/loop/loopctl.py task-context --task-id TASK-id
python scripts/loop/loopctl.py document-list --task-id TASK-id
python scripts/loop/loopctl.py document-get --task-id TASK-id --kind analysis --story 1
```

写入业务文档：

```bash
python scripts/loop/loopctl.py document-upsert --json '{"taskId":"TASK-id","actor":"analyst-agent","kind":"analysis","storyIndex":1,"title":"Story-1 Analysis","format":"markdown","content":"结论正文"}'
```

不要读写 `.project`、`90_questions.md`、`90_analysis_questions.md`、`91_test_questions.md` 或 `06_review.md`。

## 运行日志

每个 agent 必须把关键过程写入运行日志：

```bash
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event start --message "开始处理"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event tool-call --tool TOOL --message "准备调用工具"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event tool-result --tool TOOL --message "工具结果摘要"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event complete --message "处理完成"
```

## 人工确认问题

问题必须线上化：

```bash
python scripts/loop/loopctl.py question-add --json '{"taskId":"TASK-id","actor":"analyst-agent","kind":"analysis","storyIndex":1,"blockedReason":"等待用户确认业务规则","blockTask":true,"questions":[{"title":"问题标题","question":"需要用户回答的具体问题","why":"为什么必须确认","recommendation":"建议答案，可为空"}]}'
```

完成单条 delegation 后停止。持续 loop 和下一条 delegation 由外部 runner 处理。
