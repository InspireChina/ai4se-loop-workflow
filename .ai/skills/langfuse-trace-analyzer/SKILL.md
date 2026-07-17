---
name: langfuse-trace-analyzer
description: 拉取并分析单个 LoopWork Langfuse trace，定位 Agent 执行、消息聚合、工具调用、关联字段与业务期望不一致的地方。Use when the user provides a Langfuse trace id, asks to inspect/debug/analyze a trace, or says to pull a Langfuse trace locally. If no trace id is provided, ask the user for one before running the analysis.
---

# Langfuse Trace Analyzer

用于本地拉取一个具体 Langfuse trace，并基于当前项目业务规则做偏差分析。不要做全量数据集分析；每次只分析一个 trace。

## 工作流

1. **确认 trace id**
   - 如果用户没有给 trace id，先停下来询问。
   - 如果用户给了 trace id，直接继续，不要再确认。

2. **拉取 trace**
   - 从项目根目录运行：

```bash
python3 .ai/skills/langfuse-trace-analyzer/scripts/fetch_trace.py <trace_id>
```

   - 脚本会按应用相同的优先级读取当前 shell、项目 `.env` / `.env.local`，以及当前工作区数据库 `project_settings` 中的：
     - `LANGFUSE_BASE_URL`
     - `LANGFUSE_PUBLIC_KEY`
     - `LANGFUSE_SECRET_KEY`
   - 不要在回复中打印、复制或总结密钥。
   - 默认输出到 `.ai/runs/langfuse-traces/<trace_id>/`：
     - `raw_observations.json`：原始 observation 数据
     - `timeline.md`：按时间排序的节点输入输出摘要
     - `analysis.md`：自动信号和业务核对底稿

3. **读取分析材料**
   - 先读 `analysis.md` 获取自动风险信号和业务核对清单。
   - 再读 `timeline.md` 还原实际执行路径。
   - 必要时用 `rg` 或结构化解析查看 `raw_observations.json` 中的完整 `input`、`output`、`metadata`。

4. **输出诊断**
   - 先列事实，再列偏差。
   - 每个问题按这个结构写：
     - 事实：trace 中发生了什么。
     - 期望：按业务规则应该怎样。
     - 偏差：哪里不一致。
     - 影响：会造成什么用户/业务问题。
     - 建议：下一步怎么改或怎么验证。
   - 如果 trace 拉取失败，先判断是环境变量缺失、Langfuse API 失败、时间窗口太窄，还是 trace 不属于当前项目；给出可执行的下一步。

## 当前项目业务期望

分析时优先核对这些约束：

- 执行边界：一次 Harness 派发对应一个 trace 和一个闭合的 `agent.*` Span；Agent 不应自行推进其他流程。
- 最终结果：完整 AgentResult 应写入 Agent Span 和 trace 顶层 `output`，不能只存在 `metadata.summary` 或本地日志。
- 流式消息：delta、reasoning、progress 不应各自生成 output observation；一个完整助手消息最多记录一次。
- 工具调用：一次工具调用对应一个 `tool.<name>` Span，并通过稳定的 `toolCallId` 关联 input、output、状态和耗时。
- 失败语义：异常使用 WARNING/ERROR 和 statusMessage；普通 stderr 诊断不得误报为 WARNING。
- 关联完整性：metadata 应包含 `runToken`、`requirementId`、`agent`、`operation`、`node`，并通过 `sessionId` 关联同一轮运行。
- 用量语义：CLI 未报告 usage 时应明确为不可用，不得伪造为 0；报告的聚合 usage/cost 应保留数值。

## 常用命令

扩大查询窗口：

```bash
python3 .ai/skills/langfuse-trace-analyzer/scripts/fetch_trace.py <trace_id> --days 90
```

指定输出目录：

```bash
python3 .ai/skills/langfuse-trace-analyzer/scripts/fetch_trace.py <trace_id> --out-dir /tmp/langfuse-trace
```

快速查看节点名：

```bash
rg -n '^## ' .ai/runs/langfuse-traces/<trace_id>/timeline.md
```

查看完整 observation 的关键字段：

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path(".ai/runs/langfuse-traces/<trace_id>/raw_observations.json")
data = json.loads(p.read_text())
for row in data["observations"]:
    print(row.get("startTime"), row.get("type"), row.get("name"), row.get("level"), row.get("statusMessage"))
PY
```

## 注意事项

- 只分析用户指定的单个 trace，不主动跑批量分析。
- 不要把 raw trace 全文粘贴给用户；只提炼与业务偏差有关的证据。
- 如果 observation 很少，不要强行下结论；先说明可见证据不足，并建议扩大时间窗口或确认 trace id/project。
- 如果 Langfuse 旧版 `/api/public/traces/<trace_id>` 返回 502，不要卡住；脚本使用 v2 observations API 作为主路径。
