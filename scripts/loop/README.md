# Loop CLI

固定入口：

```bash
npm run loopctl -- <command>
```

实际实现位于 `scripts/loop/loopctl.ts`，读写当前 UI 使用的 `data/<repo-root-short-hash>/loop-ui.db`。

查看当前 repo 对应路径：

```bash
npm run loopctl -- paths
```

Loop 生命周期、推进步骤和结束运行只由 Web App 与内部 Runner 管理。Runner 每次只启动一个 Agent，注入完整需求上下文并接收结构化 JSON；正常 Agent 不调用本 CLI。单个 Agent 仍可在当前执行步骤内使用辅助 subagent 收集上下文。

Runner 启动 execution 前会初始化项目隔离的 `data/<repo-hash>/agent-runtime`，从中加载当前 Agent 的 `PROMPT.md`、`MEMORY.md` 和最近 daily memory，并把版本/哈希写入 execution attempt。执行结束后的 Evolution Evaluator 是非阻塞旁路：它只能记录观察或产生受 Canary 约束的 Prompt candidate，不能调度流程、绕过 Harness 或要求人工 Approval。

`agent-runner.ts` 的顶层 `finally` 会把本 execution 的结构化日志游标写入 `software_maintenance_jobs`，然后 best-effort 唤醒独立 `maintenance-runner.ts`。finally 不直接调用模型或修改代码。Maintenance Runner 在应用仓库的隔离 Git worktree 内分析 Loop Engineering 自身问题，通过变更预算、保护路径、`npm test`、`npm run build` 和 clean-baseline 检查后才能自动 cherry-pick；失败不会阻塞主 Loop。

## 人工维护与诊断命令

```bash
npm run loopctl -- status
npm run loopctl -- task-list
npm run loopctl -- task-get TASK-id
npm run loopctl -- block-list
npm run loopctl -- system-unblock TASK-id
npm run loopctl -- task-rewind TASK-id --actor human --to analysis --story 2
```

不要直接改 SQLite。`system-unblock` 只恢复自动重试耗尽后的执行异常，不能提交产品回答或绕过 Slice Spec。产品澄清在 UI 回答并提交后只恢复给 Analyst。Agent 的运行过程不需要主动上报；Runner 会直接解析所选 CLI 的 stream-json / JSONL。

这里保留的 `task-*`、`story` 等命令参数只是维护接口和数据库兼容名，不是产品界面或 Agent 提示词中的术语。
