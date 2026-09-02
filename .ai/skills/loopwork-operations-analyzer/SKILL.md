---
name: loopwork-operations-analyzer
description: 分析 LoopWork 本地生产数据库、Runner 日志、Agent 命令拒绝与 execution 重试，形成可追溯的运维诊断和产品优化建议。Use when the user asks to inspect LoopWork production behavior, periodically review operational quality, analyze loop-ui.db, or find recurring Agent/Harness failure patterns. Do not use for an isolated Langfuse trace.
---

# LoopWork Operations Analyzer

对 LoopWork 本地生产数据执行只读分析，识别重复故障、无效重试、命令协议摩擦和无人值守中断点。先还原事实，再提出产品改进；不要因发现问题而直接修改数据库、运行状态或业务仓库。

## 开始分析

从 Skill 所在目录运行随包脚本。LoopWork 启动的 Agent 优先使用应用注入的 Electron Node：

```bash
ELECTRON_RUN_AS_NODE=1 "$LOOP_DESKTOP_NODE" scripts/analyze-logs.cjs --days 30
```

PowerShell 使用：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $env:LOOP_DESKTOP_NODE scripts/analyze-logs.cjs --days 30
```

源码开发环境也可以使用 `node scripts/analyze-logs.cjs --days 30`。脚本按以下顺序定位数据库：

1. `--db <loop-ui.db>`；
2. `--data-root <LoopWork data 目录>` 与 `--workspace <工作区>`；
3. Runner 注入的 `LOOP_DATA_ROOT`；
4. 当前操作系统的 LoopWork 默认用户数据目录。

数据库无法唯一定位时，停止并向用户索要 `loop-ui.db` 路径，不要扫描无关目录。需要保留材料时使用 `--output-dir <目录>`；否则结果写入系统临时目录。

## 分析口径

- 先读脚本生成的 `report.md`，再用 `facts.json` 核对分母、时间窗口和样本量。
- 必须按命令协议形态区分 `generic-yaml` 与 `legacy`。跨版本汇总只能描述历史总量，不能直接证明当前版本仍有同一问题。
- 命令拒绝表示 Harness 阻止了一次非法写入，不等于 execution 失败。只有结合 execution 最终状态、`failure_kind`、时间顺序和后续命令，才能判断拒绝是否造成重试。
- “拒绝后成功”表示同一 execution、同一命令族后来成功；如果 execution 随后失败，要继续检查最终错误，不能把相关性写成因果性。
- 手动停止产生的 `cancelled` execution 不计作产品错误。区分用户停止、正常延期、Runner 崩溃和真实 Agent/Provider 失败。
- 比较不同 Agent 或 Runtime 时同时报告样本量，避免用小样本失败率下结论。

需要自定义 SQL、核对字段含义或脚本提示 schema 不完整时，读取 [references/data-model.md](references/data-model.md)。

## 深入取证

围绕一个异常 execution 建立短时间线：

1. execution 创建、启动、结束和最终状态；
2. 同 execution 的 `tool_event` 收据，按 receipt key 排序；
3. 最后一次拒绝、之后的修正、最后一次成功领域命令；
4. `last_error`、`failure_kind` 与相邻 `runtime_events`；
5. 同一 `dispatch_generation_key` 的后续 attempt 是否 applied。

查询生产数据库必须使用只读连接。不要输出命令凭证、Authorization、完整 Prompt、用户隐私或未脱敏的长日志。引用错误信息时保留能定位问题的最短片段。

## 输出要求

结论使用中文，至少包含：

- 数据范围：数据库、工作区、UTC 时间窗、execution 和内部命令样本量；
- 运行健康：Loop 崩溃、execution 状态、失败类型、重试及最终恢复率；
- 命令协议：当前协议与历史协议分别统计，列出高频拒绝、自纠正和仍失败的命令族；
- 因果链：对重要问题给出“事实 → 推断 → 尚缺证据”；
- 优化建议：按 P0/P1/P2 排序，说明由 Prompt、命令协议、Harness、Runtime 或可观测性中的哪一层负责；
- 验证指标：说明修改后应观察什么数据以及成功阈值。

机械参数错误优先在动态 schema、错误回执和工具接口中解决，不要把不断增长的错误样例全部塞进 Prompt 或 Durable Memory。安全校验、临时目录边界和 execution 级 receipt 归属不能为了降低拒绝率而放宽。
