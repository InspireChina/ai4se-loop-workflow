# /loop

你是 Loop Engineering 的调度入口。不要直接改 SQLite；所有状态读取和写入都必须通过：

```bash
python scripts/loop/loopctl.py ...
```

## 固定流程

1. 领取本轮租约：

```bash
RUN_TOKEN=$(python scripts/loop/loopctl.py run-begin --lease-minutes 120)
```

如果提示 busy，停止本轮并向用户说明已有 loop run 正在执行。

2. 获取本轮委派：

```bash
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN" --format jsonl
```

3. 对每一行 JSONL：

- `agent=backlog-agent`：收集上下文，必要时执行 `task-context-init --actor backlog-agent`，再用 `task-update` 推进到 `in plan`、`in repro` 或 `blocked`。
- `agent=story-splitter-agent`：拆分 Story，更新 `total_stories` 和状态。
- `agent=analyst-agent`：处理指定 Story 的 requirements/plan；需要人工确认时调用 `question-add --json` 创建结构化问题并进入 `blocked`。
- `agent=repro-agent`：复现 Bug 并写复现材料。
- `agent=dev-agent`：实现指定 Story，完成后推进 `dev_index`。
- `agent=test-agent`：黑盒测试指定 Story，完成后推进 `test_index` 或回流。
- `agent=review-agent`：审查完整 Task，写 `06_review.md`，需要人工批准时进入 `blocked`。

每个 subagent 必须使用 JSONL envelope 中的 `task_id`、`work_dir`、`story_index`、`pipeline` 和 `description`。

每个 subagent 还必须把关键过程写入运行日志。日志入口：

```bash
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event start --message "开始处理"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event tool-call --tool TOOL --message "准备调用工具"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event tool-result --tool TOOL --message "工具结果摘要"
python scripts/loop/loopctl.py run-log --run-token "$RUN_TOKEN" --agent AGENT --task-id TASK-id --pipeline PIPELINE --event complete --message "处理完成"
```

至少记录：subagent 开始、重要工具调用、工具结果摘要、状态写入、完成、阻塞或失败。不要把大段文件全文写入日志，只写摘要和路径。

## 人工确认问题

不要写 `90_questions.md`、`90_analysis_questions.md` 或 `91_test_questions.md`。产品化版本的问题全部线上化，必须通过 CLI 提交结构化 JSON，系统会直接写入 `questions` 表，前端会在 Task 详情页展示。

JSON 格式：

```json
{
  "taskId": "TASK-id",
  "actor": "analyst-agent",
  "kind": "analysis",
  "storyIndex": 1,
  "blockedReason": "等待用户确认业务规则",
  "blockTask": true,
  "questions": [
    {
      "title": "问题标题",
      "question": "需要用户回答的具体问题",
      "why": "为什么必须确认",
      "recommendation": "建议答案，可为空"
    }
  ]
}
```

调用示例：

```bash
python scripts/loop/loopctl.py question-add --json '{"taskId":"TASK-id","actor":"analyst-agent","kind":"analysis","storyIndex":1,"blockedReason":"等待用户确认业务规则","blockTask":true,"questions":[{"title":"问题标题","question":"需要用户回答的具体问题","why":"为什么必须确认","recommendation":"建议答案，可为空"}]}'
```

4. 所有委派完成后，不要主动释放租约。

Loop Engineering 产品化版本是持续 loop：App/runner 会在本轮 agent 完成后等待一段时间并继续下一轮派发。`run-end` 只用于用户在 UI 点击“结束本轮”或人工运维停止持续 loop。

如果中途失败，不要强制释放；向用户报告失败点和当前 token。只有确认需要人工停止整个持续 loop，且没有 subagent 继续执行时，才允许人工运维执行：

```bash
python scripts/loop/loopctl.py run-end "$RUN_TOKEN" --force
```

## 汇报

汇报时展示 Task 标题、pipeline、agent、Story 和结果。不要展示内部实现细节，除非用户要求。
