# 拆分 `phase complete` 的内部职责

## 状态

- 状态：已记录，暂缓处理
- 范围：YAML 命令链运行时
- 当前决策：保留对 Agent 暴露的 `phase complete` 命令协议，本轮统一注册中心重构不改变其语义

## 背景

所有 YAML 命令链阶段都通过 `phase complete` 表达“当前阶段工作已经完成，请 Harness 继续处理”。这个外部意图是稳定且合理的，Agent 不应分别调用校验、推进、暂停或提交等 Harness 内部步骤。

当前内部实现将 `phase complete` 与 `phase rewind` 放在同一个执行分支，并直接承担了以下职责：

1. 校验命令参数和当前阶段状态。
2. 执行当前 Phase 的业务校验器。
3. 判断 Decision 或 Runtime Input 是否需要等待外部输入。
4. 计算并持久化下一阶段。
5. 编译终态 `AgentResult`。
6. 发布 Requirement Acceptance 和 Verification Assessment 等命令链特有实体。
7. 更新 Draft 与 Execution 的终态。
8. 维护阶段跳转、回退清理和数据库事务。
9. 渲染命令结果及下一工作包。

因此，这个 Handler 会同时因为阶段策略、等待规则、命令链结果格式、实体发布方式、持久化结构和回退语义的变化而修改，内部职责边界过宽。

## 目标边界

未来保持外部命令不变，将内部实现收敛为完成阶段用例的编排器：

```text
phase complete
  -> CompletionPolicy.evaluate
  -> reject | advance | suspend | finish
  -> PhaseTransition | ChainSuspension | ChainFinalizer
  -> CompletionStore transaction
```

- `CompletionPolicy`：根据当前 builtin Phase 执行校验并决定下一动作。
- `PhaseTransition`：只负责正常推进阶段。
- `ChainSuspension`：只负责等待 Decision 或 Runtime Input。
- `ChainFinalizer`：按命令链编译结果并执行终态发布 Hook。
- `CompletionStore`：在明确的事务边界内持久化 Draft、Execution 和 Transition。
- `phase rewind`：作为独立用例处理回退校验和后续数据清理。

## 本轮不做

- 不改变 `phase complete` 的命令文本、参数和 Agent Prompt。
- 不改变 YAML、默认配置或 OpenSpec 配置的 YAML 结构。
- 不改变现有校验、暂停、阶段推进、终态编译和发布语义。
- 不在统一注册中心重构中顺带拆分该 Handler。

## 重新处理的触发条件

满足任一条件时重新评估：

- 新增 builtin Phase 必须继续修改 `phase complete` 的中心执行分支。
- 新增命令链需要增加新的终态编译或发布特例。
- 等待、恢复或回退规则出现新的链级分支。
- 当前 Handler 阻碍命令注册中心的独立测试或无损迁移。

## 完成标准

- 外部 `phase complete` 协议保持兼容。
- 完成、暂停、推进与回退分别具有独立契约测试。
- 所有现有命令链在重构前后的命令输出、数据库结果和 `AgentResult` 等价。
- Requirement Acceptance 与 Verification Assessment 的发布仍与终态提交处于同一事务边界。
- `phase complete` Handler 不再包含具体命令链 ID 或 builtin ID 的条件分支。
