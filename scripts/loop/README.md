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

Run 生命周期、Pipeline 派发和结束运行只由 Web App 与内部 Runner 管理。Runner 每次只启动一个 Agent，注入完整上下文并接收结构化 JSON；正常 Agent 不调用本 CLI。单个 agent 仍可在当前 delegation 内使用辅助 subagent 收集上下文。

## 人工维护与诊断命令

```bash
python scripts/loop/loopctl.py status
python scripts/loop/loopctl.py task-list
python scripts/loop/loopctl.py task-get TASK-id
python scripts/loop/loopctl.py block-list
python scripts/loop/loopctl.py block-release TASK-id
python scripts/loop/loopctl.py task-update TASK-id --actor analyst-agent --status blocked --blocked-reason "..."
python scripts/loop/loopctl.py task-rewind TASK-id --actor human --to analysis --story 2
```

不要直接改 SQLite。所有 Task 状态、游标、blocked、release 和 rewind 都通过 CLI 或 UI command。Agent 的运行过程不需要主动上报；Runner 会直接解析所选 CLI 的 stream-json / JSONL。
