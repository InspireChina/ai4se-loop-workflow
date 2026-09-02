# LoopWork 运维分析数据模型

## 核心数据源

- `execution_attempts`：一次 Agent 派发尝试。使用 `dispatch_generation_key` 关联同一逻辑工作的重试；`attempt` 可能在新的 retry cycle 中重新开始。
- `execution_receipts`：execution 的持久收据。`kind='tool_event'` 保存规范化工具生命周期；同一工具调用通常有 started/completed 两条记录。
- `runtime_events`：Runner、执行器和应用产生的结构化事件。优先使用 `exception_fingerprint` 聚合同一异常。
- `run_logs`：面向人的 Loop 文本日志，可用于补充时间线，不适合作为唯一统计来源。
- `loop_runs`：Loop 生命周期。`crashed` 与人工 `stopped` 必须分开统计。
- `task_events`：需求活动记录。用于核对用户可见的错误是否与底层失败一致。
- `schema_migrations`：数据库能力与协议迁移的最低证据，但不能代替真实应用版本字段。

所有 SQLite `CURRENT_TIMESTAMP` 文本按 UTC 解读。

## 命令收据

只统计 `tool_event` payload 中 `phase='completed'` 的记录，避免 started/completed 双计数。领域命令应满足 `input.command` 包含 `loop-agent.mjs` 或 `loop-agent.cjs`。

常见字段：

- `toolCallId`：一次工具调用的稳定关联键；
- `commandHash`：命令文本哈希；
- `success`、`exitCode`：completed 结果；
- `summary`：经过边界处理的短结果；
- `input.command`：可能包含长参数，展示前必须脱敏和截断。

命令族应从可执行文件之后的非参数 token 提取。新版通用协议以 `status`、`artifact`、`decision`、`acceptance`、`check`、`runtime-input`、`metadata`、`phase` 等开头；旧的 Agent namespace 命令统一标记为 `legacy`。

## execution 失败

优先使用 `failure_kind`，不要只解析 `last_error`。常见状态：

- `applied`：结果已经成功应用；
- `retryable_failed`：本 attempt 失败但仍允许自动重试；
- `system_blocked`：重试耗尽或系统门禁阻塞；
- `cancelled`：可能是用户停止、需求取消或派发回收，需要结合活动事件判断，不能默认算失败；
- `output_received`、`verifying`、`applying`：已有结果，可能处于恢复或应用阶段。

统计重试恢复率时，按 `dispatch_generation_key` 聚合，并明确“有后续 attempt 的 generation”与“attempt>1 的行数”不是同一指标。

## 因果判断

一次命令拒绝后 execution 最终失败，只能说明两者同处一个 execution。认定命令摩擦造成重试，至少需要满足：

1. 最后一个未解决领域命令是 rejected/failed；
2. 之后没有同命令族 accepted 收据；
3. execution 的最终错误指向缺少终止命令、命令协议或相同校验问题；
4. 时间顺序中没有独立的 Provider、进程、超时或 Runner 故障。

无法满足时，将结论写为相关性，并列出需要补充的事件或版本字段。
