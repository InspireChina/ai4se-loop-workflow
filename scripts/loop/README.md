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

Loop 生命周期、推进步骤和结束运行只由 Web App 与内部 Runner 管理。交付拆分后，每个任务最多同时运行一个 Analysis Agent 和一个 Delivery Agent；Analysis 独立向前，Delivery 串行执行 Dev/Test。任一 Lane 完成都会立即触发重新调度，不存在整批等待屏障。Runner 为每个角色注入经过权限投影的冻结上下文；正常流程 Agent 通过 execution 绑定的渐进命令提交结果，不生成通用 JSON，也不调用维护 CLI。任务详情页的上下文 Chat 是独立通道：它不依赖 Loop Runner 是否启动，通过读取命令获取当前需求及其已经产出的文档。Chat 永远不直接修改目标仓库或既有交付事实；用户明确要求实施变化时，Chat 可通过当前 turn 绑定的领域命令提交任意多个带稳定 key 的变更请求，进入与详情文档评论相同的 Feedback 闭环。Feedback Agent 先分类、合并或拆分，需要实施时按实际边界向前追加任意多个交付单元，再经过 Analysis、Dev、Test 与独立反馈验证。Chat 不占用代码槽，也不暂停当前需求的 Delivery Lane；同一 turn 的请求收集完成后才开始 Feedback 派发。

Runner 启动 execution 前会初始化项目隔离的 `data/<repo-hash>/agent-runtime`，从中加载当前 Agent 的 `PROMPT.md`、`MEMORY.md` 和最近 daily memory。每次派发还会按 Agent 读取独立的执行器、模型与思考强度；同一轮不同 Lane 不再共享统一 Runtime，Agent 的 Evolution Evaluator 沿用该 Agent 的配置。系统 Prompt Template 只在项目第一次初始化 Agent 时复制为项目数据库中的完整 Current Prompt；随后用户直接编辑这一份，应用升级不会覆盖。自动演化期间每个 Agent 至多有一个完整 Prompt Canary candidate。Runtime Prompt 文件只接受数据库单向物化，不反向导入配置，也不承担历史或恢复；Memory 仍保留 revision 历史。execution attempt 保存实际发送给模型的完整 Prompt snapshot、input hash、项目 Prompt revision、初始模板 version、Prompt hash 与 Memory revision/hash。调用 Codex 或 Claude 时，完整 Prompt 通过 stdin 传输；调用 Cursor 时，完整 Prompt 写入权限受限的临时文档，命令行只传递短文件引用，CLI 退出后统一清理。

所有流程 Agent 都使用 `scripts/loop/loop-agent.mjs <角色命名空间> ...` 渐进提交：每次新进程先执行 `status` 恢复上次草稿，再按稳定 key 写入各字段，最终调用角色终止命令。Runner 通过 execution 或内部工作 ID、会话 ID 与一次性 token 限制命令权限；Agent 不生成结果 JSON，也不能直接写数据库。Evolution Evaluator 使用 `evolution` 命名空间，Software Maintenance Agent 使用 `maintenance` 命名空间，并遵循同一套先恢复、渐进写入、终止提交协议。普通最终回复不推进流程。执行结束后的 Evolution Evaluator 是非阻塞旁路：它只能记录观察或产生至多一个受 Canary 约束的完整 Prompt candidate，不能调度流程、绕过 Harness 或要求人工 Approval。同一 candidate 同时最多由一个 execution 验证；系统从持久化 execution 终态可重放地计算结果。candidate 三次 Canary 全部成功且原 Prompt revision 未变化后原子替换 Current Prompt 并删除，任一次失败或用户编辑则丢弃且当前 Prompt 不变；配置域不保存 Prompt 历史，UI 也不提供恢复入口。execution 中已经冻结的完整 Prompt snapshot 和版本信息继续保留为只读审计。

验证 Agent 使用精简的两阶段协议：先通过 `verification plan upsert` 维护 `frontend` 或 `api` 黑盒场景，必要时在规划阶段 `verification plan dismiss`，覆盖完整后调用 `verification plan freeze`；再逐项使用 `verification result record` 记录通过、失败或阻塞，最终调用 `verification complete`。每项交付单元验收语义必须有真实前端业务闭环场景；API 场景可以补充业务边界、错误反馈和数据语义，也可以直接形成失败证据，但不能替代前端闭环的通过证据。测试资源不足时使用运行信息请求，仍无法获得则记录环境阻塞。角色帮助按 `context|plan|execute|input|finish` 组织，不要求 Agent 提交执行回执。

流程 Agent 默认最多运行 4 小时，完全无输出 30 分钟后终止；可分别通过 `AGENT_EXECUTOR_TIMEOUT_MS` 和 `AGENT_EXECUTOR_IDLE_TIMEOUT_MS` 覆盖。Runner 持续写入 heartbeat 与持久化 execution checkpoint；进程异常退出后由恢复逻辑判断未完成 execution 并继续处理，不依赖长期租约。

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

不要直接改 SQLite。`system-unblock` 只恢复自动重试耗尽后的执行异常；并行推进中的 Analysis/Delivery 阻塞应通过 `--lane` 精确恢复，不能提交设计回答或绕过交付规格。需求级澄清在 UI 回答并提交后只恢复给需求梳理 Agent；交付级关键决策只恢复给对应的交付分析 Agent。交付分析 Agent 把 Do It Twice 作为内部思考方法，只持久化实际影响、关键业务或技术决策和冻结交付契约；只有超出权限且会产生实质不同交付后果的最少决策才交给用户。Application 校验稳定 decision key、回答消费、影响处理和契约完整性。Delivery 通道按 `Dev → Test` 形成稳定待测仓库状态，但 Test 的只读上下文排除 Dev 自述、自检、开发记录和 Commit message；Dev 与 Test 只共享交付分析冻结的契约。Agent 的运行过程不需要主动上报；Runner 会直接解析所选 CLI 的 stream-json / JSONL。

这里保留的 `task-*`、`story` 等命令参数只是维护接口和数据库兼容名，不是产品界面或 Agent 提示词中的术语。
