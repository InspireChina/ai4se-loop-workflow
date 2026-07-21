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

Loop 生命周期、推进步骤和结束运行只由 Web App 与内部 Runner 管理。交付拆分后，每个任务最多同时运行一个 Analysis Agent 和一个 Delivery Agent；Analysis 独立向前，Delivery 串行执行 Dev/Test。任一 Lane 完成都会立即触发重新调度，不存在整批等待屏障。Runner 注入该任务的完整上下文并接收结构化 JSON；正常 Agent 不调用本 CLI。

Runner 启动 execution 前会初始化项目隔离的 `data/<repo-hash>/agent-runtime`，从中加载当前 Agent 的 `PROMPT.md`、`MEMORY.md` 和最近 daily memory，并把版本/哈希写入 execution attempt。调用 Codex 或 Claude 时，完整 Prompt 通过 stdin 传输；调用 Cursor 时，完整 Prompt 写入权限受限的临时文档，命令行只传递短文件引用，CLI 退出后统一清理。流程 Agent、Evolution Evaluator 和 Software Maintenance Agent 的每个 execution 都会获得私有临时结果通道；Agent 使用 Prompt 中给出的 `submit-agent-result --input <result.json>` 命令提交对应类型的 Result Receipt。提交命令同步执行完整 Schema 和静态角色契约校验，失败时保留输入供 Agent 修正重提；成功后 Runner 防御性复验并持久化，最终文本 JSON 仅作兼容 fallback。执行结束后的 Evolution Evaluator 是非阻塞旁路：它只能记录观察或产生受 Canary 约束的 Prompt candidate，不能调度流程、绕过 Harness 或要求人工 Approval。

`agent-runner.ts` 的顶层 `finally` 会把本 execution 的结构化日志游标写入 `software_maintenance_jobs`，然后 best-effort 唤醒独立 `maintenance-runner.ts`。finally 不直接调用模型或修改代码。Maintenance Runner 在应用仓库的隔离 Git worktree 内分析 Loop Engineering 自身问题，通过变更预算、保护路径、`npm test`、`npm run build` 和 clean-baseline 检查后才能自动 cherry-pick；失败不会阻塞主 Loop。

## 人工维护与诊断命令

```bash
npm run loopctl -- status
npm run loopctl -- task-list
npm run loopctl -- task-get TASK-id
npm run loopctl -- block-list
npm run loopctl -- system-unblock TASK-id
npm run loopctl -- system-unblock TASK-id --lane analysis
npm run loopctl -- system-unblock TASK-id --lane delivery
npm run loopctl -- task-rewind TASK-id --actor human --to analysis --story 2
```

不要直接改 SQLite。`system-unblock` 只恢复自动重试耗尽后的执行异常；并行推进中的 Analysis/Delivery 阻塞应通过 `--lane` 精确恢复，不能提交设计回答或绕过 Slice Spec。需求级澄清在 UI 回答并提交后只恢复给需求梳理 Agent；单元级设计澄清只恢复给对应的 Analyst。Analyst 的 Slice Spec 必须覆盖完整关键决策树，包括产品决策和重大技术决策；所有无上下文证据的关键决策都必须形成用户问题，Harness 不接受 `safe_default`。Agent 的运行过程不需要主动上报；Runner 会直接解析所选 CLI 的 stream-json / JSONL。

这里保留的 `task-*`、`story` 等命令参数只是维护接口和数据库兼容名，不是产品界面或 Agent 提示词中的术语。
