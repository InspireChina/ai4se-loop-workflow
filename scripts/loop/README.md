# Loop CLI

固定入口：

```bash
python scripts/loop/loopctl.py <command>
```

该 Python 文件是兼容 shim，实际实现位于 `scripts/loop/loopctl.ts`，读写当前 UI 使用的 `data/<repo-root-short-hash>/loop-ui.db`。

查看当前 repo 对应路径：

```bash
python scripts/loop/loopctl.py paths
```

## 一轮 loop

```bash
RUN_TOKEN=$(python scripts/loop/loopctl.py run-begin --lease-minutes 120)
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN" --format jsonl
python scripts/loop/loopctl.py run-end "$RUN_TOKEN"
```

`pipeline-all` 输出 JSONL envelope，Cursor `/loop` 命令按 `agent` 字段把每行交给对应 subagent。

## 常用命令

```bash
python scripts/loop/loopctl.py status
python scripts/loop/loopctl.py task-list
python scripts/loop/loopctl.py task-get TASK-id
python scripts/loop/loopctl.py block-list
python scripts/loop/loopctl.py block-release TASK-id
python scripts/loop/loopctl.py task-update TASK-id --actor analyst-agent --status blocked --blocked-reason "..."
python scripts/loop/loopctl.py task-rewind TASK-id --actor human --to analysis --story 2
```

不要直接改 SQLite。所有 Task 状态、游标、blocked、release 和 rewind 都通过 CLI 或 UI command。
