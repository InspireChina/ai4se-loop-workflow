#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DEFAULT_FIELDS = "core,basic,time,io,metadata,model,usage,metrics,trace_context"


def load_local_config(project_root: Path) -> None:
    """Mirror LoopWork's env + active-workspace project_settings resolution."""
    explicit_env = set(os.environ)
    for name in (".env", ".env.local"):
        env_path = project_root / name
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key in explicit_env:
                continue
            os.environ[key] = value.strip().strip('"').strip("'")

    workspace_root = os.getenv("LOOP_WORKSPACE_ROOT_OVERRIDE")
    app_db = project_root / "data" / "loopwork.db"
    if not workspace_root and app_db.exists():
        try:
            with sqlite3.connect(app_db) as connection:
                row = connection.execute(
                    "SELECT setting_value FROM app_settings WHERE setting_key = 'workspace_root'"
                ).fetchone()
            workspace_root = row[0] if row else None
        except sqlite3.Error:
            workspace_root = None
    resolved_workspace = str(Path(workspace_root or os.getenv("LOOP_WORKSPACE_ROOT") or project_root).resolve())
    repo_hash = hashlib.sha1(resolved_workspace.encode("utf-8")).hexdigest()[:12]
    workspace_db = project_root / "data" / repo_hash / "loop-ui.db"
    if not workspace_db.exists():
        return
    try:
        with sqlite3.connect(workspace_db) as connection:
            rows = dict(connection.execute(
                "SELECT setting_key, setting_value FROM project_settings WHERE setting_key LIKE 'langfuse_%'"
            ).fetchall())
    except sqlite3.Error:
        return
    mapping = {
        "LANGFUSE_BASE_URL": "langfuse_base_url",
        "LANGFUSE_PUBLIC_KEY": "langfuse_public_key",
        "LANGFUSE_SECRET_KEY": "langfuse_secret_key",
    }
    for env_key, setting_key in mapping.items():
        if env_key not in explicit_env and rows.get(setting_key):
            os.environ[env_key] = rows[setting_key]


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip().strip('"')
    if not value:
        raise SystemExit(f"缺少环境变量 {name}；请检查项目根目录 .env 或当前 shell 环境。")
    return value


def request_json(base_url: str, public_key: str, secret_key: str, path: str, retries: int = 2) -> dict[str, Any]:
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
    url = base_url.rstrip("/") + path
    last_error = ""
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            last_error = f"HTTP {exc.code}: {body}"
            if exc.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise RuntimeError(last_error) from exc
        except Exception as exc:
            last_error = str(exc)
            if attempt == retries:
                raise RuntimeError(last_error) from exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(last_error)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_v2_observations(
    *,
    trace_id: str,
    base_url: str,
    public_key: str,
    secret_key: str,
    days: int,
    limit: int,
) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    params: dict[str, str] = {
        "traceId": trace_id,
        "fromStartTime": iso_z(now - timedelta(days=days)),
        "toStartTime": iso_z(now + timedelta(minutes=5)),
        "limit": str(limit),
        "fields": DEFAULT_FIELDS,
    }
    rows: list[dict[str, Any]] = []
    cursor = ""
    while True:
        query = dict(params)
        if cursor:
            query["cursor"] = cursor
        path = "/api/public/v2/observations?" + urllib.parse.urlencode(query)
        data = request_json(base_url, public_key, secret_key, path)
        batch = data.get("data") or []
        if not isinstance(batch, list):
            raise RuntimeError("Langfuse v2 observations 返回格式异常：data 不是列表")
        rows.extend(batch)
        meta = data.get("meta") or {}
        cursor = meta.get("cursor") or ""
        if not cursor:
            break
    rows.sort(key=lambda row: (row.get("startTime") or "", row.get("id") or ""))
    return rows


def compact(value: Any, max_chars: int = 900) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    text = " ".join(text.split())
    if len(text) > max_chars:
        return text[:max_chars] + "..."
    return text


def trace_summary(rows: list[dict[str, Any]], trace_id: str) -> dict[str, Any]:
    first = rows[0] if rows else {}
    names = [row.get("name") for row in rows if row.get("name")]
    errors = [
        row for row in rows
        if row.get("level") not in (None, "DEFAULT")
    ]
    generations = [row for row in rows if str(row.get("type", "")).upper() == "GENERATION"]
    agent_spans = [row for row in rows if str(row.get("type", "")).upper() == "SPAN" and str(row.get("name") or "").startswith("agent.")]
    tool_spans = [row for row in rows if str(row.get("type", "")).upper() == "SPAN" and str(row.get("name") or "").startswith("tool.")]
    total_usage = sum(int(row.get("totalUsage") or 0) for row in rows)
    total_cost = sum(float(row.get("totalCost") or 0) for row in rows)
    return {
        "trace_id": trace_id,
        "trace_name": first.get("traceName"),
        "user_id": first.get("userId"),
        "session_id": first.get("sessionId"),
        "tags": first.get("tags") or [],
        "observation_count": len(rows),
        "generation_count": len(generations),
        "agent_span_count": len(agent_spans),
        "tool_span_count": len(tool_spans),
        "legacy_output_event_count": sum(row.get("name") == "loop.agent.output" for row in rows),
        "metadata_summary_count": sum(isinstance(row.get("metadata"), dict) and "summary" in row["metadata"] for row in rows),
        "error_like_count": len(errors),
        "total_usage": total_usage,
        "total_cost": total_cost,
        "first_start_time": rows[0].get("startTime") if rows else None,
        "last_start_time": rows[-1].get("startTime") if rows else None,
        "observation_names": dict(Counter(names)),
    }


def write_timeline(rows: list[dict[str, Any]], out_path: Path, summary: dict[str, Any]) -> None:
    lines = [
        f"# Langfuse Trace Timeline: {summary['trace_id']}",
        "",
        f"- trace_name: `{summary.get('trace_name') or ''}`",
        f"- user_id: `{summary.get('user_id') or ''}`",
        f"- session_id: `{summary.get('session_id') or ''}`",
        f"- observation_count: `{summary.get('observation_count')}`",
        f"- generation_count: `{summary.get('generation_count')}`",
        "",
    ]
    for i, row in enumerate(rows, 1):
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        displayed_model = row.get("model") or row.get("providedModelName") or metadata.get("reportedModel") or metadata.get("configuredModel") or ""
        displayed_usage = row.get("totalUsage") or metadata.get("reportedUsage") or ""
        lines.extend([
            f"## {i}. {row.get('name') or '(unnamed)'}",
            "",
            f"- id: `{row.get('id')}`",
            f"- type: `{row.get('type')}`",
            f"- start: `{row.get('startTime')}`",
            f"- end: `{row.get('endTime')}`",
            f"- parent: `{row.get('parentObservationId') or ''}`",
            f"- level/status: `{row.get('level') or ''}` / `{row.get('statusMessage') or ''}`",
            f"- model: `{displayed_model}`",
            f"- usage: `{compact(displayed_usage, 500)}`",
            f"- latency: `{row.get('latency') or ''}`",
            "",
        ])
        if metadata:
            lines.extend(["**metadata**", "", "```json", json.dumps(metadata, ensure_ascii=False, indent=2, default=str)[:3000], "```", ""])
        if row.get("input") is not None:
            lines.extend(["**input 摘要**", "", compact(row.get("input")), ""])
        if row.get("output") is not None:
            lines.extend(["**output 摘要**", "", compact(row.get("output")), ""])
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def automatic_findings(rows: list[dict[str, Any]], summary: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    if not rows:
        findings.append("未拉取到任何 observation。请扩大 --days 时间窗口，或确认 trace_id 与当前 Langfuse project 匹配。")
        return findings
    if not summary.get("session_id"):
        findings.append("trace 缺少 session_id，难以关联一次会话或任务。")
    if summary.get("error_like_count"):
        findings.append(f"发现 {summary['error_like_count']} 个非默认 level observation，需要优先检查。")
    if summary.get("generation_count") == 0 and summary.get("agent_span_count") == 0:
        findings.append("既没有 GENERATION，也没有 agent.* Span；Agent/模型执行可能没有被结构化记录。")
    if summary.get("legacy_output_event_count", 0) > 3:
        findings.append(f"发现 {summary['legacy_output_event_count']} 个 loop.agent.output EVENT，输出很可能按流分片而非按完整消息记录。")
    if summary.get("metadata_summary_count"):
        findings.append(f"发现 {summary['metadata_summary_count']} 个 metadata.summary；消息正文应优先放在 observation/trace output。")
    if summary.get("agent_span_count"):
        empty_agent_outputs = [row for row in rows if str(row.get("name") or "").startswith("agent.") and row.get("output") is None]
        if empty_agent_outputs:
            findings.append(f"发现 {len(empty_agent_outputs)} 个 agent.* Span 没有最终 output。")
    incomplete_spans = [
        row for row in rows
        if str(row.get("type", "")).upper() == "SPAN"
        and (str(row.get("name") or "").startswith("agent.") or str(row.get("name") or "").startswith("tool."))
        and not row.get("endTime")
    ]
    if incomplete_spans:
        findings.append(f"发现 {len(incomplete_spans)} 个 agent/tool Span 没有 endTime，可能未正常闭合。")
    long_rows = [row for row in rows if row.get("latency") and float(row["latency"]) > 30]
    if long_rows:
        findings.append(f"发现 {len(long_rows)} 个 latency > 30s 的 observation，需检查慢调用、重试或阻塞。")
    empty_outputs = [row for row in rows if str(row.get("type", "")).upper() == "GENERATION" and not row.get("output")]
    if empty_outputs:
        findings.append(f"发现 {len(empty_outputs)} 个 generation 输出为空。")
    root_metadata = rows[0].get("metadata") if isinstance(rows[0].get("metadata"), dict) else {}
    missing_correlation = [key for key in ("runToken", "requirementId", "agent", "operation", "node") if not root_metadata.get(key)]
    if missing_correlation:
        findings.append(f"trace 缺少关联维度：{', '.join(missing_correlation)}。")
    return findings


def write_analysis(rows: list[dict[str, Any]], out_path: Path, summary: dict[str, Any]) -> None:
    findings = automatic_findings(rows, summary)
    lines = [
        f"# Langfuse Trace 分析底稿: {summary['trace_id']}",
        "",
        "## 基本信息",
        "",
        "```json",
        json.dumps(summary, ensure_ascii=False, indent=2, default=str),
        "```",
        "",
        "## 自动发现的风险信号",
        "",
    ]
    if findings:
        lines.extend(f"- {item}" for item in findings)
    else:
        lines.append("- 未发现明显结构性风险；仍需结合业务期望逐项核对。")
    lines.extend([
        "",
        "## 业务期望核对清单",
        "",
        "- 执行边界：一次 Harness 派发对应一个 trace 和一个闭合的 agent.* Span，不应由 Agent 自行推进其他流程。",
        "- 最终结果：完整 AgentResult 应位于 agent Span 与 trace 顶层 output，不应只存在 metadata.summary 或本地日志。",
        "- 流式消息：delta/reasoning/progress 不应各自生成 output observation；一个完整助手消息最多记录一次。",
        "- 工具调用：一次调用对应一个 tool.<name> Span，并通过 toolCallId 关联 input、output、状态和耗时。",
        "- 失败语义：异常 Span 使用 WARNING/ERROR 和 statusMessage；普通 stderr 诊断不得误报为 WARNING。",
        "- 关联完整性：metadata 应包含 runToken、requirementId、agent、operation、node，并通过 sessionId 关联同一轮运行。",
        "- 用量语义：CLI 未报告 usage 时应标记 unknown/不可用，不得伪造为 0；报告的聚合 usage/cost 应保留数值。",
        "",
        "## 下一步人工分析要求",
        "",
        "1. 从 `timeline.md` 逐个节点还原实际执行路径。",
        "2. 对照上面的业务期望，指出“事实 -> 偏差 -> 影响 -> 建议修复”。",
        "3. 不要只总结模型回复；重点检查消息聚合、工具配对、Span 闭合、最终输出、关联字段和错误等级。",
    ])
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="拉取单个 Langfuse trace 的 observations 并生成本地分析底稿。")
    parser.add_argument("trace_id", help="Langfuse trace id")
    parser.add_argument("--project-root", default=".", help="项目根目录，默认当前目录")
    parser.add_argument("--out-dir", default="", help="输出目录；默认 .ai/runs/langfuse-traces/<trace_id>")
    parser.add_argument("--days", type=int, default=30, help="向前查询多少天，默认 30")
    parser.add_argument("--limit", type=int, default=100, help="每页 observation 数量，默认 100")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    load_local_config(project_root)
    base_url = require_env("LANGFUSE_BASE_URL")
    public_key = require_env("LANGFUSE_PUBLIC_KEY")
    secret_key = require_env("LANGFUSE_SECRET_KEY")

    out_dir = Path(args.out_dir) if args.out_dir else project_root / ".ai" / "runs" / "langfuse-traces" / args.trace_id
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = fetch_v2_observations(
        trace_id=args.trace_id,
        base_url=base_url,
        public_key=public_key,
        secret_key=secret_key,
        days=args.days,
        limit=args.limit,
    )
    summary = trace_summary(rows, args.trace_id)
    payload = {
        "fetched_at": iso_z(datetime.now(timezone.utc)),
        "source": {
            "base_url": base_url,
            "api": "/api/public/v2/observations",
            "days": args.days,
            "fields": DEFAULT_FIELDS,
        },
        "summary": summary,
        "observations": rows,
    }
    (out_dir / "raw_observations.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    write_timeline(rows, out_dir / "timeline.md", summary)
    write_analysis(rows, out_dir / "analysis.md", summary)

    print(json.dumps({
        "trace_id": args.trace_id,
        "observation_count": len(rows),
        "out_dir": str(out_dir),
        "files": ["raw_observations.json", "timeline.md", "analysis.md"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
