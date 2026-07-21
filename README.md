# LoopWork

LoopWork 是一个面向 **L4 Development** 的 AI 软件开发 Workflow Infra。它将工作重心从“人通过 Chat 持续推动 Agent”转为“确定性的 Harness 持续驱动多个专业 Agent”，使需求能够跨会话完成分析、开发、验证、恢复和结卡。

详细设计见 [L4 LOOP 工作手册](./docs/l4-loop-handbook.md)。

## 核心原则

- **最小交付单元**：将长任务拆成决策明确、可以独立验证的业务切片，缩短无验证距离。
- **确定性外环，自主内环**：Harness 管理状态、权限、验证和恢复；Agent 处理分析、实现和诊断。
- **人负责业务，系统负责工程**：人只提供目标、回答不可推导的业务歧义，并检查最终业务产出。
- **Claim、Evidence、Result 分离**：Agent 提交声明，Harness 保存证据并决定是否通过。
- **状态持久化**：规格、决策、Memory、执行结果和验证证据保存在对话之外，使任务可以继续、重试或 rewind。
- **职责独立**：Analyst、Dev、Test 和 Review Agent 分别处理规格、实现、验证和结卡。

## Development Loop

需求录入后，LoopWork 自动接管流程；除需求澄清、必要运行信息和最终验收外，不需要人逐步批准。

```mermaid
flowchart LR
    input["录入需求"] --> context["收集上下文"]
    context --> split["划分交付单元"]
    split --> clarify["需求澄清"]
    clarify --> dev["开发"]
    dev --> test["独立测试"]
    test --> passed{"通过?"}
    passed -->|"否"| rewind["诊断与 Rewind"]
    rewind --> clarify
    passed -->|"是"| completed{"全部单元完成?"}
    completed -->|"否"| split
    completed -->|"是"| review["统一验收与结卡报告"]
    review --> human["人工检查业务产出"]
```

每个交付单元都形成版本化 Slice Spec，记录目标、范围、决策、Acceptance Criteria、验证计划和变更预算。Dev Agent 只处理当前单元；Harness 执行确定性检查；Test Agent 优先从用户入口进行黑盒验证；Review Agent 汇总最终范围、证据、风险和遗留项。

## 人机边界

LoopWork 只在以下情况请求人介入：

1. 存在无法从代码、文档和已有事实推导的业务歧义。
2. 当前 Agent 缺少不可替代的非敏感运行信息。
3. 事件超出权限、风险或执行环境边界。
4. 所有交付单元完成后，需要检查最终业务产出。

人的回答会成为新的事实，而不是对 Plan 或代码的 Approval。普通实现失败和测试失败由系统自动诊断、重试或 rewind。

生产环境采用 Human Gate：Agent 可以只读分析线上日志、Trace、告警和指标，但所有线上结果必须通知人，生产发布、修复和回滚由人确认。

## Workflow Infra

不同项目的 Prompt 和业务知识不同，但底层 Workflow 基本相同。LoopWork 统一提供：

- Agent 调度和节点间上下文交接。
- Workflow 状态机、任务队列和代码槽。
- 版本化 Prompt、Memory、项目知识和 Slice Spec。
- 结构化 Agent Result、Harness Evidence 和 Trace。
- execution attempt、Receipt、中断恢复、重试和 rewind。
- Feedback Agent 的评论分流、处理验证和 Harness Resolve。
- 权限边界、人工介入和可插拔执行器。
- 受限的 Prompt 演化和 LoopWork 自维护闭环。

项目只需要注入自己的 Agent Profile、领域知识、AC、工具、权限和验证规则；后续可以进一步通过 Skill 和 Workflow Profile 复用这些配置。统一的是“如何可靠运行一个 Loop”，而不是“每个项目应该做什么”。

## 当前范围

| Profile | 状态 |
| --- | --- |
| L4 Development | 已运行主要闭环：需求规格 → 交付单元 → 开发 → 测试 → 结卡 |
| Human-gated L4 Delivery | 设计阶段：Agent 监测线上环境，生产操作由人确认 |
| L4 End-to-End | 设计阶段：客户需求 → BA → 工程交付 → 业务结果 |

当前实现采用 Next.js、SQLite 和本地 Runner。它支持 Cursor、Codex 和 Claude CLI，但尚未证明大规模并发能力；Worktree 提供 Git 隔离，不等同于 OS 级安全沙箱。

## 快速开始

要求 Node.js 环境，并预先安装至少一种可用的 Agent CLI：Cursor、Codex 或 Claude。

```bash
npm install
npm run db:migrate
npm run dev
```

打开 `http://localhost:3000`，在项目设置中选择目标仓库和 Agent 执行器，然后在运行页面启动 Loop。

常用命令：

```bash
npm test
npm run build
npm run loopctl -- status
npm run loopctl -- paths
```

## 技术文档

- [L4 LOOP 工作手册](./docs/l4-loop-handbook.md)：WHY、设计原则、Development / Delivery / End-to-End 与统一 Infra。
- [V1 技术方案](./docs/v1-technical-solution.md)：架构、持久化、执行协议和验收标准。
- [DDD 边界与模型](./docs/v1-ddd-boundaries.md)：统一语言、限界上下文和领域不变量。

## 目录

```text
app/                 Next.js 页面与 Server Actions
src/domain/          领域模型与协议
src/application/     Workflow 用例与状态推进
src/infrastructure/  数据库、Agent、验证与运行适配器
scripts/loop/         Runner、Maintenance Runner 与 loopctl
migrations/          项目数据库迁移
docs/                工作手册与技术文档
```
