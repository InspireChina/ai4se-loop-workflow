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

- `agent=source-agent`：先执行 `python scripts/loop/loopctl.py paths` 获取 `inbox_path`，读取该文件，将新输入用 `task-ingest --actor source-agent` 幂等写入；成功后执行 `inbox-commit`。
- `agent=backlog-agent`：收集上下文，必要时执行 `task-context-init --actor backlog-agent`，再用 `task-update` 推进到 `in plan`、`in repro` 或 `blocked`。
- `agent=story-splitter-agent`：拆分 Story，更新 `total_stories` 和状态。
- `agent=analyst-agent`：处理指定 Story 的 requirements/plan；需要人工确认时写 `90_analysis_questions.md` 并进入 `blocked`。
- `agent=repro-agent`：复现 Bug 并写复现材料。
- `agent=dev-agent`：实现指定 Story，完成后推进 `dev_index`。
- `agent=test-agent`：黑盒测试指定 Story，完成后推进 `test_index` 或回流。
- `agent=review-agent`：审查完整 Task，写 `06_review.md`，需要人工批准时进入 `blocked`。

每个 subagent 必须使用 JSONL envelope 中的 `task_id`、`work_dir`、`story_index`、`pipeline` 和 `description`。

4. 所有委派完成后释放租约：

```bash
python scripts/loop/loopctl.py run-end "$RUN_TOKEN"
```

如果中途失败，不要强制释放；向用户报告失败点和当前 token。只有确认没有 subagent 继续执行时，才允许：

```bash
python scripts/loop/loopctl.py run-end "$RUN_TOKEN" --force
```

## 汇报

汇报时展示 Task 标题、pipeline、agent、Story 和结果。不要展示内部实现细节，除非用户要求。
