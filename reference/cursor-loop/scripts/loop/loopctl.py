#!/usr/bin/env python
"""Small CLI for the Cursor loop SQLite database."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path.cwd()
DEFAULT_DB = Path(".project/_loop/loop.db")
DEFAULT_SCHEMA = Path(".project/_loop/schema.sql")
DEFAULT_INBOX = Path(".project/_loop/inbox.md")
DEFAULT_BLOCK_DIR = Path(".project/_loop/blocks")
LOOPCTL_PATH = "scripts/loop/loopctl.py"


AGILE_STATUSES = [
    "backlog",
    "in plan",
    "in repro",
    "ready for dev",
    "in dev",
    "in review",
    "done",
    "cancelled",
    "blocked",
]


BROWSER_RESOURCE_AGENTS = {"backlog-agent", "repro-agent", "test-agent"}

AGENT_ACTORS = {
    "source-agent",
    "backlog-agent",
    "story-splitter-agent",
    "analyst-agent",
    "repro-agent",
    "dev-agent",
    "test-agent",
    "review-agent",
}
ACTORS = sorted(AGENT_ACTORS | {"human"})

UPDATE_FIELD_PERMISSIONS = {
    "backlog-agent": {"title", "status", "current_subagent", "next_step", "blocked_reason", "work_dir", "item_type", "priority"},
    "story-splitter-agent": {"status", "current_subagent", "analysis_index", "dev_index", "test_index", "total_stories", "next_step", "blocked_reason"},
    "analyst-agent": {"status", "current_subagent", "analysis_index", "next_step", "blocked_reason", "approval_file"},
    "repro-agent": {"status", "current_subagent", "next_step", "blocked_reason"},
    "dev-agent": {"status", "current_subagent", "dev_index", "next_step", "blocked_reason"},
    "test-agent": {"status", "current_subagent", "test_index", "next_step", "blocked_reason"},
    "review-agent": {"status", "current_subagent", "next_step", "blocked_reason", "work_dir", "approval_file"},
}

UPDATE_STATUS_PERMISSIONS = {
    "backlog-agent": {"backlog", "in plan", "in repro", "blocked"},
    "story-splitter-agent": {"in plan", "ready for dev", "in dev", "blocked"},
    "analyst-agent": {"ready for dev", "in dev", "blocked"},
    "repro-agent": {"in repro", "in plan", "blocked"},
    "dev-agent": {"in dev", "blocked"},
    "test-agent": {"in dev", "in review", "blocked"},
    "review-agent": {"in review", "blocked", "done"},
}

CURRENT_SUBAGENT_PERMISSIONS = {
    "backlog-agent": {"backlog-agent", "story-splitter-agent", "repro-agent"},
    "story-splitter-agent": {"story-splitter-agent", "analyst-agent"},
    "analyst-agent": {"analyst-agent"},
    "repro-agent": {"repro-agent", "story-splitter-agent"},
    "dev-agent": {"dev-agent"},
    "test-agent": {"test-agent", "review-agent"},
    "review-agent": {"review-agent"},
}

ALLOWED_STATUS_TRANSITIONS = {
    "backlog": {"backlog", "in plan", "in repro", "blocked"},
    "in repro": {"in repro", "in plan", "blocked"},
    "in plan": {"in plan", "ready for dev", "blocked"},
    "ready for dev": {"ready for dev", "in dev", "blocked"},
    "in dev": {"in dev", "in review", "blocked"},
    "in review": {"in review", "done", "blocked"},
    "done": {"done"},
    "cancelled": {"cancelled"},
    "blocked": {"blocked"},
}


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def run_init(args: argparse.Namespace) -> None:
    schema_path = Path(args.schema)
    if not schema_path.exists():
        raise SystemExit(f"schema not found: {schema_path}")
    schema = schema_path.read_text(encoding="utf-8")
    with connect(Path(args.db)) as conn:
        tasks_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
        ).fetchone()
        if not tasks_exists:
            conn.executescript(schema)
            print(f"initialized {args.db}")
            return

        # Existing databases first receive migration-safe columns. The table
        # is then rebuilt transactionally so new CHECK constraints and status
        # values also apply to databases created from older schema versions.
        conn.executescript(
            "CREATE TABLE IF NOT EXISTS meta ("
            "  key TEXT PRIMARY KEY,"
            "  value TEXT NOT NULL,"
            "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
            ");"
        )

        cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        had_analysis_approval = "analysis_approved_index" in cols

        required = {
            "external_id": "TEXT",
            "title": "TEXT NOT NULL DEFAULT ''",
            "link": "TEXT",
            "item_type": "TEXT NOT NULL DEFAULT 'other'",
            "priority": "TEXT",
            "external_status": "TEXT",
            "agile_status": "TEXT NOT NULL DEFAULT 'backlog'",
            "current_subagent": "TEXT",
            "analysis_index": "INTEGER NOT NULL DEFAULT 0",
            "dev_index": "INTEGER NOT NULL DEFAULT 0",
            "test_index": "INTEGER NOT NULL DEFAULT 0",
            "total_stories": "INTEGER NOT NULL DEFAULT 0",
            "next_step": "TEXT",
            "work_dir": "TEXT",
            "blocked_reason": "TEXT",
            "resume_status": "TEXT",
            "resume_pending": "INTEGER NOT NULL DEFAULT 0",
            "analysis_approved_index": "INTEGER NOT NULL DEFAULT 0",
            "review_approved": "INTEGER NOT NULL DEFAULT 0",
            "approval_file": "TEXT",
            "last_actor": "TEXT",
            "owner": "TEXT",
            "evidence": "TEXT",
            "risk": "TEXT",
            "created_at": "TEXT",
            "updated_at": "TEXT",
            "completed_at": "TEXT",
        }
        for col, col_def in required.items():
            if col not in cols:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {col_def}")

        # Existing analyzed stories predate the approval gate. Preserve their
        # progress while requiring all new/reopened analysis to use the gate.
        if not had_analysis_approval:
            conn.execute(
                "UPDATE tasks SET analysis_approved_index = analysis_index"
            )
        else:
            conn.execute(
                "UPDATE tasks SET analysis_approved_index = analysis_index "
                "WHERE analysis_approved_index < analysis_index "
                "OR analysis_approved_index > analysis_index + 1 "
                "OR analysis_approved_index > total_stories"
            )

        conn.execute(
            "UPDATE tasks SET created_at = COALESCE(created_at, datetime('now')), "
            "updated_at = COALESCE(updated_at, datetime('now'))"
        )

        template = sqlite3.connect(":memory:")
        try:
            template.executescript(schema)
            table_sql = template.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
            ).fetchone()[0]
            index_sqls = [
                row[0]
                for row in template.execute(
                    "SELECT sql FROM sqlite_master "
                    "WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL"
                ).fetchall()
            ]
            current_columns = [
                row[1] for row in template.execute("PRAGMA table_info(tasks)").fetchall()
            ]
        finally:
            template.close()

        legacy_table = "tasks_legacy_loopctl"
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (legacy_table,),
        ).fetchone():
            raise SystemExit(
                f"migration recovery required: unexpected table {legacy_table} already exists"
            )

        old_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        common_columns = [name for name in current_columns if name in old_columns]
        quoted_columns = ", ".join(f'"{name}"' for name in common_columns)

        for index_row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL"
        ).fetchall():
            escaped = index_row["name"].replace('"', '""')
            conn.execute(f'DROP INDEX "{escaped}"')

        conn.execute(f"ALTER TABLE tasks RENAME TO {legacy_table}")
        conn.execute(table_sql)
        conn.execute(
            f"INSERT INTO tasks ({quoted_columns}) "
            f"SELECT {quoted_columns} FROM {legacy_table}"
        )
        conn.execute(f"DROP TABLE {legacy_table}")
        for index_sql in index_sqls:
            conn.execute(index_sql)

        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('schema_version', '23') "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
        )
    print(f"initialized {args.db}")


def slugify(value: str) -> str:
    """Create a readable filesystem segment from a business title.

    Keep CJK characters so Chinese card titles remain recognizable. The goal is
    a human-friendly work directory, not a globally unique technical key.
    """
    chars = []
    last_dash = False
    for ch in value.strip().lower():
        if ch.isalnum():
            chars.append(ch)
            last_dash = False
        elif not last_dash:
            chars.append("-")
            last_dash = True
    slug = "".join(chars).strip("-")
    return slug[:60]


def build_work_slug(title: str | None, explicit_slug: str | None) -> str:
    slug = slugify(explicit_slug or title or "")
    if not slug:
        raise SystemExit(
            "cannot derive work directory name; pass --slug with a short business name"
        )
    if slug.startswith("task-") or slug.startswith("task_"):
        raise SystemExit(
            "work directory name looks like a technical task id; pass --slug with a business name"
        )
    normalized = slug.replace("-", "").replace("_", "")
    if normalized.isdigit() or normalized in {"task", "bug", "feature", "tech", "intake", "需求", "问题"}:
        raise SystemExit(
            "work directory name is too generic; pass --slug with a short business name"
        )
    return slug


def task_id_from_link(title: str, link: str | None) -> str:
    seed = link or title
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8]
    return f"TASK-{digest}"


def validate_pipeline_state(state: dict[str, object], context: str) -> None:
    values = {
        name: int(state.get(name) or 0)
        for name in ("test_index", "dev_index", "analysis_index", "total_stories")
    }
    if not (
        0 <= values["test_index"]
        <= values["dev_index"]
        <= values["analysis_index"]
        <= values["total_stories"]
    ):
        raise SystemExit(
            f"invalid pipeline state for {context}: require "
            "0 <= test_index <= dev_index <= analysis_index <= total_stories, got "
            f"t={values['test_index']} d={values['dev_index']} "
            f"a={values['analysis_index']} total={values['total_stories']}"
        )

    approved = int(state.get("analysis_approved_index") or 0)
    if not values["analysis_index"] <= approved <= min(
        values["analysis_index"] + 1, values["total_stories"]
    ):
        raise SystemExit(
            f"invalid analysis approval for {context}: require analysis_index <= "
            "analysis_approved_index <= min(analysis_index + 1, total_stories), got "
            f"a={values['analysis_index']} approved={approved} total={values['total_stories']}"
        )

    status = str(state.get("agile_status") or "")
    if status == "ready for dev" and values["total_stories"] == 0:
        raise SystemExit(f"invalid pipeline state for {context}: ready for dev requires stories")
    if status == "in review" and not (
        values["total_stories"] > 0
        and values["test_index"]
        == values["dev_index"]
        == values["analysis_index"]
        == values["total_stories"]
    ):
        raise SystemExit(
            f"invalid pipeline state for {context}: in review requires all stories analyzed, developed, and tested"
        )
    if status == "blocked" and (
        not str(state.get("current_subagent") or "").strip()
        or not str(state.get("blocked_reason") or "").strip()
    ):
        raise SystemExit(
            f"invalid blocked state for {context}: current_subagent and blocked_reason are required"
        )


def validate_status_transition(before, next_status: str | None) -> None:
    if next_status is None:
        return
    if next_status == "cancelled":
        raise SystemExit("use task-cancel for duplicate, withdrawn, or invalid tasks")
    current = before["agile_status"]
    if next_status not in ALLOWED_STATUS_TRANSITIONS.get(current, set()):
        raise SystemExit(
            f"invalid status transition: {current} -> {next_status}; use task-rewind for reverse flow"
        )


def authorize_task_update(before, args: argparse.Namespace) -> None:
    if args.actor == "human":
        return
    allowed_fields = UPDATE_FIELD_PERMISSIONS.get(args.actor)
    if allowed_fields is None:
        raise SystemExit(f"{args.actor} is not allowed to update existing tasks")
    changed_fields = {
        name
        for name in (
            "title", "status", "current_subagent", "analysis_index", "dev_index",
            "test_index", "total_stories", "next_step", "blocked_reason",
            "work_dir", "item_type", "priority", "approval_file",
        )
        if getattr(args, name) is not None
    }
    forbidden = changed_fields - allowed_fields
    if forbidden:
        raise SystemExit(
            f"{args.actor} cannot update field(s): {', '.join(sorted(forbidden))}"
        )
    if args.status is not None and args.status not in UPDATE_STATUS_PERMISSIONS[args.actor]:
        raise SystemExit(f"{args.actor} cannot set agile_status={args.status}")
    if (
        args.current_subagent is not None
        and args.current_subagent not in CURRENT_SUBAGENT_PERMISSIONS[args.actor]
    ):
        raise SystemExit(
            f"{args.actor} cannot assign current_subagent={args.current_subagent}"
        )
    if before["resume_pending"] and args.actor != before["current_subagent"]:
        raise SystemExit(
            f"resume is reserved for {before['current_subagent']}; {args.actor} cannot consume it"
        )


def validate_forward_index_updates(before, args: argparse.Namespace) -> None:
    for name in ("analysis_index", "dev_index", "test_index"):
        value = getattr(args, name, None)
        if value is None:
            continue
        old_value = int(before[name])
        if value < old_value:
            raise SystemExit(
                f"{name} cannot move backward through task-update; use task-rewind"
            )
        if value > old_value + 1:
            raise SystemExit(
                f"{name} may advance by at most one story per update: {old_value} -> {value}"
            )
    total = getattr(args, "total_stories", None)
    if total is not None and total < int(before["total_stories"]):
        raise SystemExit("total_stories cannot move backward through task-update; use task-rewind --to plan")


def ensure_single_active_code_slot(conn: sqlite3.Connection, task_id: str, next_status: str | None) -> None:
    if next_status not in {"in dev", "in review"}:
        return
    row = conn.execute(
        """
        SELECT task_id, title, agile_status, work_dir
        FROM tasks
        WHERE (
          agile_status IN ('in dev', 'in review')
          OR (agile_status = 'blocked' AND resume_status IN ('in dev', 'in review'))
          OR (agile_status = 'blocked' AND current_subagent = 'review-agent')
        ) AND task_id != ?
        LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    if row:
        raise SystemExit(
            "another task is already occupying the code slot: "
            f"{row['task_id']} | {row['agile_status']} | {row['title']} | {row['work_dir'] or ''}. "
            "No worktree is configured, so only one task may be in dev, review, or blocked from dev/review at a time."
        )


def normalized_path(path: str) -> Path:
    return (ROOT / Path(path)).resolve() if not Path(path).is_absolute() else Path(path).resolve()


def validate_approval_file(actor: str, work_dir: str | None, approval_file: str | None) -> None:
    if actor not in {"analyst-agent", "review-agent"}:
        return
    if not work_dir:
        raise SystemExit(f"{actor} cannot request approval without work_dir")
    if not approval_file:
        raise SystemExit(f"{actor} must pass --approval-file when entering blocked")

    work_path = normalized_path(work_dir)
    approval_path = normalized_path(approval_file)
    try:
        approval_path.relative_to(work_path)
    except ValueError as exc:
        raise SystemExit("approval_file must be inside the task work_dir") from exc

    expected_name = (
        "90_analysis_questions.md" if actor == "analyst-agent" else "06_review.md"
    )
    if approval_path.name != expected_name:
        raise SystemExit(f"{actor} approval_file must be named {expected_name}")
    if not approval_path.exists() or not approval_path.is_file():
        raise SystemExit(f"approval file not found: {approval_path}")
    if read_approval_decision(str(approval_path), actor) != "pending":
        raise SystemExit(
            f"{expected_name} must contain a pending decision when {actor} enters blocked"
        )


def read_approval_decision(path_value: str, actor: str) -> str:
    path = Path(path_value)
    if not path.exists() or not path.is_file():
        raise SystemExit(f"approval file not found: {path}")
    text_value = path.read_text(encoding="utf-8")
    if actor == "analyst-agent":
        key = "Analysis Decision"
        aliases = {
            "pending": "pending",
            "待确认": "pending",
            "continue": "continue",
            "继续": "continue",
            "继续澄清": "continue",
            "请继续澄清": "continue",
            "confirmed": "confirmed",
            "confirm": "confirmed",
            "已确认": "confirmed",
            "确认完成": "confirmed",
        }
    elif actor == "review-agent":
        key = "Review Decision"
        aliases = {
            "pending": "pending",
            "待确认": "pending",
            "approved": "approved",
            "approve": "approved",
            "已批准": "approved",
            "确认交付": "approved",
            "确认完成": "approved",
            "changes_requested": "changes_requested",
            "changes-requested": "changes_requested",
            "要求修改": "changes_requested",
            "驳回": "changes_requested",
        }
    else:
        raise SystemExit(f"{actor} does not use an approval decision file")

    pattern = re.compile(
        rf"^\s*(?:[-*]\s*)?{re.escape(key)}\s*[:：]\s*(.*?)\s*$",
        re.IGNORECASE | re.MULTILINE,
    )
    matches = pattern.findall(text_value)
    if not matches:
        raise SystemExit(f"missing `{key}: ...` in {path}")
    raw = matches[-1].strip().strip("`").lower().replace(" ", "_")
    decision = aliases.get(raw)
    if decision is None:
        raise SystemExit(f"unsupported {key} value in {path}: {matches[-1].strip()}")
    if decision == "pending" and actor == "analyst-agent":
        # Keep compatibility with natural-language answers written into the
        # current round's user-confirmation field. Older rounds are ignored.
        round_markers = list(
            re.finditer(r"^\s*Clarification Round\s*[:：]", text_value, re.MULTILINE)
        )
        current_round = text_value[round_markers[-1].start():] if round_markers else text_value
        user_decisions = re.findall(
            r"^\s*(?:-\s*)?用户确认\s*[:：]\s*(.*?)\s*$",
            current_round,
            re.MULTILINE,
        )
        if user_decisions:
            natural = user_decisions[-1].strip().strip("`")
            if natural in {"继续", "继续澄清", "请继续澄清"}:
                return "continue"
            if natural in {"已确认", "确认完成"}:
                return "confirmed"
    return decision


def validate_done_archive(work_dir: str | None, approval_file: str | None) -> None:
    if not work_dir or not approval_file:
        raise SystemExit(
            "done requires --work-dir and --approval-file pointing to the archived review"
        )
    work_path = normalized_path(work_dir)
    archive_root = normalized_path(".project/archive")
    try:
        relative = work_path.relative_to(archive_root)
    except ValueError as exc:
        raise SystemExit("done work_dir must be inside .project/archive") from exc
    if len(relative.parts) < 2 or relative.parts[0] not in {"features", "bugs", "tech"}:
        raise SystemExit("done work_dir must be inside an archive type directory")
    if not work_path.exists() or not work_path.is_dir():
        raise SystemExit(f"archive work_dir not found: {work_path}")
    approval_path = normalized_path(approval_file)
    if approval_path != work_path / "06_review.md" or not approval_path.is_file():
        raise SystemExit("done approval_file must be the archived work_dir/06_review.md")


def run_task_add(args: argparse.Namespace) -> None:
    task_id = args.task_id or task_id_from_link(args.title, args.link)
    if args.actor not in {"source-agent", "human"}:
        raise SystemExit(f"{args.actor} cannot add tasks")
    if args.actor == "source-agent" and (
        args.status != "backlog" or args.current_subagent is not None
    ):
        raise SystemExit("source-agent may only add unassigned backlog tasks")
    validate_pipeline_state(
        {
            "agile_status": args.status,
            "analysis_index": args.analysis_index,
            "dev_index": args.dev_index,
            "test_index": args.test_index,
            "total_stories": args.total_stories,
            "current_subagent": args.current_subagent,
            "blocked_reason": args.blocked_reason,
        },
        task_id,
    )
    with connect(Path(args.db)) as conn:
        ensure_single_active_code_slot(conn, task_id, args.status)
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO tasks(
              task_id, external_id,
              title, link, item_type, priority, external_status,
              agile_status, current_subagent,
              analysis_index, dev_index, test_index, total_stories,
              next_step, blocked_reason, last_actor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                args.external_id,
                args.title,
                args.link,
                args.item_type,
                args.priority,
                args.external_status,
                args.status,
                args.current_subagent,
                args.analysis_index,
                args.dev_index,
                args.test_index,
                args.total_stories,
                args.next_step,
                args.blocked_reason,
                args.actor,
            ),
        )
        row = fetch_task(conn, task_id)
        if row is None and args.link:
            row = conn.execute("SELECT * FROM tasks WHERE link = ?", (args.link,)).fetchone()
    if cur.rowcount != 0 and row is not None and args.status == "blocked":
        write_block_file(row)
    if cur.rowcount != 0 and row is not None:
        write_loop_state_file(row)
    print(row["task_id"] if row is not None else task_id)


def run_task_ingest(args: argparse.Namespace) -> None:
    """Idempotently add a task using URL as the key."""
    task_id = args.task_id or task_id_from_link(args.title, args.link)
    if args.actor not in {"source-agent", "human"}:
        raise SystemExit(f"{args.actor} cannot ingest tasks")
    if args.actor == "source-agent" and (
        args.status != "backlog" or args.current_subagent is not None
    ):
        raise SystemExit("source-agent may only ingest unassigned backlog tasks")
    validate_pipeline_state(
        {
            "agile_status": args.status,
            "analysis_index": args.analysis_index,
            "dev_index": args.dev_index,
            "test_index": args.test_index,
            "total_stories": args.total_stories,
            "current_subagent": args.current_subagent,
            "blocked_reason": args.blocked_reason,
        },
        task_id,
    )
    with connect(Path(args.db)) as conn:
        ensure_single_active_code_slot(conn, task_id, args.status)
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO tasks(
              task_id, external_id,
              title, link, item_type, priority, external_status,
              agile_status, current_subagent,
              analysis_index, dev_index, test_index, total_stories,
              next_step, blocked_reason, last_actor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                args.external_id,
                args.title,
                args.link,
                args.item_type,
                args.priority,
                args.external_status,
                args.status,
                args.current_subagent,
                args.analysis_index,
                args.dev_index,
                args.test_index,
                args.total_stories,
                args.next_step,
                args.blocked_reason,
                args.actor,
            ),
        )
        row = conn.execute("SELECT task_id FROM tasks WHERE link = ?", (args.link,)).fetchone()
    existing_or_created = row["task_id"] if row else task_id
    if cur.rowcount != 0:
        with connect(Path(args.db)) as conn:
            new_row = fetch_task(conn, existing_or_created)
        if new_row is not None and args.status == "blocked":
            write_block_file(new_row)
        if new_row is not None:
            write_loop_state_file(new_row)
    if cur.rowcount == 0:
        print(f"200 OK exists {existing_or_created}")
    else:
        print(f"200 OK created {existing_or_created}")


def run_task_list(args: argparse.Namespace) -> None:
    where = []
    params: list[str] = []
    if args.status:
        where.append("agile_status = ?")
        params.append(args.status)
    if not args.all and not args.status:
        where.append("agile_status NOT IN ('done', 'cancelled')")
    sql = (
        "SELECT task_id, agile_status, priority, title, current_subagent, "
        "analysis_index, dev_index, test_index, total_stories, next_step FROM tasks"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(str(args.limit))
    with connect(Path(args.db)) as conn:
        rows = conn.execute(sql, params).fetchall()
    for row in rows:
        print(
            f"{row['task_id']} | {row['agile_status']} | {row['priority'] or ''} | "
            f"{row['title']} | current={row['current_subagent'] or ''} | "
            f"a={row['analysis_index']}/{row['total_stories']} "
            f"d={row['dev_index']} t={row['test_index']} | {row['next_step'] or ''}"
        )


def run_task_url_list(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        rows = conn.execute(
            """
            SELECT link
            FROM tasks
            WHERE link IS NOT NULL AND trim(link) != ''
            ORDER BY link
            """
        ).fetchall()
    for row in rows:
        print(row["link"])


def run_task_get(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        row = conn.execute(
            """
            SELECT task_id, agile_status, priority, title, link, item_type,
                   current_subagent,
                   analysis_index, dev_index, test_index, total_stories,
                   next_step, work_dir, blocked_reason, resume_status, resume_pending,
                   analysis_approved_index, review_approved, approval_file, last_actor
            FROM tasks WHERE task_id = ?
            """,
            (args.task_id,),
        ).fetchone()
    if row is None:
        raise SystemExit(f"task not found: {args.task_id}")
    print(f"task_id: {row['task_id']}")
    print(f"agile_status: {row['agile_status']}")
    print(f"priority: {row['priority'] or ''}")
    print(f"title: {row['title']}")
    print(f"link: {row['link'] or ''}")
    print(f"item_type: {row['item_type']}")
    print(f"current_subagent: {row['current_subagent'] or ''}")
    print(f"analysis_index: {row['analysis_index']}")
    print(f"dev_index: {row['dev_index']}")
    print(f"test_index: {row['test_index']}")
    print(f"total_stories: {row['total_stories']}")
    print(f"next_step: {row['next_step'] or ''}")
    print(f"work_dir: {row['work_dir'] or ''}")
    print(f"blocked_reason: {row['blocked_reason'] or ''}")
    print(f"resume_status: {row['resume_status'] or ''}")
    print(f"resume_pending: {row['resume_pending']}")
    print(f"analysis_approved_index: {row['analysis_approved_index']}")
    print(f"review_approved: {row['review_approved']}")
    print(f"approval_file: {row['approval_file'] or ''}")
    print(f"last_actor: {row['last_actor'] or ''}")


def run_task_update(args: argparse.Namespace) -> None:
    fields = []
    params: list[str] = []
    mapping = {
        "title": "title",
        "status": "agile_status",
        "current_subagent": "current_subagent",
        "analysis_index": "analysis_index",
        "dev_index": "dev_index",
        "test_index": "test_index",
        "total_stories": "total_stories",
        "next_step": "next_step",
        "blocked_reason": "blocked_reason",
        "work_dir": "work_dir",
        "item_type": "item_type",
        "priority": "priority",
        "approval_file": "approval_file",
    }
    for arg_name, column in mapping.items():
        value = getattr(args, arg_name)
        if value is not None:
            fields.append(f"{column} = ?")
            params.append(value)
    if not fields:
        raise SystemExit("nothing to update")
    with connect(Path(args.db)) as conn:
        before = fetch_task(conn, args.task_id)
        if before is None:
            raise SystemExit(f"task not found: {args.task_id}")
        authorize_task_update(before, args)
        if args.status == "blocked" and before["agile_status"] != "blocked":
            validate_approval_file(args.actor, before["work_dir"], args.approval_file)
        if before["agile_status"] == "blocked" and args.status not in (None, "blocked"):
            raise SystemExit(
                "blocked tasks must be restored with block-release before another status transition"
            )
        validate_status_transition(before, args.status)
        validate_forward_index_updates(before, args)
        prospective = dict(before)
        for arg_name, column in mapping.items():
            value = getattr(args, arg_name)
            if value is not None:
                prospective[column] = value
        validate_pipeline_state(prospective, args.task_id)
        if (
            args.analysis_index is not None
            and args.analysis_index > before["analysis_index"]
            and before["analysis_approved_index"] < args.analysis_index
        ):
            raise SystemExit(
                f"story-{args.analysis_index} analysis is not human-approved; "
                "complete the approval file and run block-release first"
            )
        if args.status == "done" and not before["review_approved"]:
            raise SystemExit(
                "review is not human-approved; 06_review.md must be approved through block-release"
            )
        if args.status == "done":
            validate_done_archive(args.work_dir, args.approval_file)
        ensure_single_active_code_slot(conn, args.task_id, args.status)
        if args.status == "blocked" and before["agile_status"] != "blocked":
            fields.append("resume_status = ?")
            params.append(before["agile_status"])
        elif args.status is not None and args.status != "blocked":
            fields.append("resume_status = NULL")
            if args.blocked_reason is None:
                fields.append("blocked_reason = NULL")
        if args.status == "done":
            fields.append("completed_at = datetime('now')")
        elif args.status is not None:
            fields.append("completed_at = NULL")
        if args.status == "in review" and before["agile_status"] != "in review":
            fields.append("review_approved = 0")
            fields.append("approval_file = NULL")
        if (
            args.analysis_index is not None
            and args.analysis_index > before["analysis_index"]
        ):
            fields.append("approval_file = NULL")
        fields.append("last_actor = ?")
        params.append(args.actor)
        fields.append("resume_pending = 0")
        fields.append("updated_at = datetime('now')")
        params.append(args.task_id)
        cursor = conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE task_id = ?", params)
        if cursor.rowcount == 0:
            raise SystemExit(f"task not found: {args.task_id}")
        row = fetch_task(conn, args.task_id)
    if row is not None:
        if args.status == "blocked":
            write_block_file(row)
        elif args.status is not None:
            clear_block_file(row)
        write_loop_state_file(row)
    print(f"updated {args.task_id}")


def run_task_rewind(args: argparse.Namespace) -> None:
    """Safely invalidate pipeline work from a story or from story splitting."""
    with connect(Path(args.db)) as conn:
        row = fetch_task(conn, args.task_id)
        if row is None:
            raise SystemExit(f"task not found: {args.task_id}")
        if row["agile_status"] == "blocked":
            raise SystemExit("release the blocked task before rewinding it")
        if row["agile_status"] in {"done", "cancelled"}:
            raise SystemExit("terminal tasks must be restored manually before rewind")
        rewind_permissions = {
            "analyst-agent": {"plan"},
            "dev-agent": {"analysis"},
            "test-agent": {"analysis", "dev"},
            "review-agent": {"plan", "analysis", "dev", "test"},
        }
        if args.actor != "human" and args.to not in rewind_permissions.get(args.actor, set()):
            raise SystemExit(f"{args.actor} cannot rewind to {args.to}")
        if row["resume_pending"] and args.actor != row["current_subagent"]:
            raise SystemExit(
                f"resume is reserved for {row['current_subagent']}; {args.actor} cannot consume it"
            )

        occupied_code_slot = row_occupies_code_slot(row) or row["dev_index"] > 0
        target_agent = {
            "plan": "story-splitter-agent",
            "analysis": "analyst-agent",
            "dev": "dev-agent",
            "test": "test-agent",
        }[args.to]

        if args.to == "plan":
            analysis_index = dev_index = test_index = total_stories = 0
            analysis_approved_index = 0
            next_status = "in dev" if occupied_code_slot else "in plan"
            story_label = "all stories"
        else:
            if row["total_stories"] <= 0:
                raise SystemExit("cannot rewind a story before story splitting is complete")
            if args.story is None or not 1 <= args.story <= row["total_stories"]:
                raise SystemExit(
                    f"--story must be between 1 and {row['total_stories']} for --to {args.to}"
                )
            boundary = args.story - 1
            analysis_index = row["analysis_index"]
            dev_index = row["dev_index"]
            test_index = row["test_index"]
            total_stories = row["total_stories"]
            analysis_approved_index = row["analysis_approved_index"]
            if args.to == "analysis":
                analysis_index = min(analysis_index, boundary)
                analysis_approved_index = min(analysis_approved_index, boundary)
                dev_index = min(dev_index, boundary)
                test_index = min(test_index, dev_index)
            elif args.to == "dev":
                dev_index = min(dev_index, boundary)
                test_index = min(test_index, dev_index)
            else:
                test_index = min(test_index, boundary)
            next_status = "in dev" if occupied_code_slot or dev_index > 0 else "ready for dev"
            story_label = f"story-{args.story}"

        prospective = dict(row)
        prospective.update(
            {
                "agile_status": next_status,
                "analysis_index": analysis_index,
                "dev_index": dev_index,
                "test_index": test_index,
                "total_stories": total_stories,
                "analysis_approved_index": analysis_approved_index,
            }
        )
        validate_pipeline_state(prospective, args.task_id)
        ensure_single_active_code_slot(conn, args.task_id, next_status)
        reason = args.reason or f"rewind {story_label} to {args.to}"
        conn.execute(
            """
            UPDATE tasks
            SET agile_status = ?, current_subagent = ?,
                analysis_index = ?, dev_index = ?, test_index = ?, total_stories = ?,
                analysis_approved_index = ?, review_approved = 0, approval_file = NULL,
                next_step = ?, blocked_reason = NULL, resume_status = NULL,
                resume_pending = 0, last_actor = ?, completed_at = NULL,
                updated_at = datetime('now')
            WHERE task_id = ?
            """,
            (
                next_status,
                target_agent,
                analysis_index,
                dev_index,
                test_index,
                total_stories,
                analysis_approved_index,
                reason,
                args.actor,
                args.task_id,
            ),
        )
        updated = fetch_task(conn, args.task_id)

    if updated is not None:
        clear_block_file(updated)
        write_loop_state_file(updated)
    print(
        f"rewound {args.task_id} to {args.to}: "
        f"status={next_status} a={analysis_index} d={dev_index} t={test_index} total={total_stories}"
    )


def run_task_cancel(args: argparse.Namespace) -> None:
    """Explicitly stop a duplicate, withdrawn, or invalid task."""
    with connect(Path(args.db)) as conn:
        row = fetch_task(conn, args.task_id)
        if row is None:
            raise SystemExit(f"task not found: {args.task_id}")
        if row["agile_status"] == "done":
            raise SystemExit("done tasks cannot be cancelled")
        if row["agile_status"] == "cancelled":
            print(f"already cancelled {args.task_id}")
            return
        if row_occupies_code_slot(row) and not args.confirm_code_clean:
            raise SystemExit(
                "task owns the active code/review slot; clean or preserve its branch and "
                "working tree, then rerun with --confirm-code-clean"
            )
        conn.execute(
            """
            UPDATE tasks
            SET agile_status = 'cancelled', current_subagent = NULL,
                next_step = ?, blocked_reason = NULL, resume_status = NULL,
                resume_pending = 0, review_approved = 0, approval_file = NULL,
                last_actor = 'human', completed_at = datetime('now'), updated_at = datetime('now')
            WHERE task_id = ?
            """,
            (f"已取消：{args.reason}", args.task_id),
        )
        updated = fetch_task(conn, args.task_id)
    clear_block_file(updated)
    write_loop_state_file(updated)
    print(f"cancelled {args.task_id}")


def run_task_context_init(args: argparse.Namespace) -> None:
    kind_to_dir = {
        "feature": "features",
        "bug": "bugs",
        "tech": "tech",
        "intake": "intake",
    }
    with connect(Path(args.db)) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (args.task_id,)).fetchone()
        if row is None:
            raise SystemExit(f"task not found: {args.task_id}")
        if args.actor not in {"backlog-agent", "human"}:
            raise SystemExit(f"{args.actor} cannot create or initialize task context")
        if args.actor == "backlog-agent":
            if args.status is not None and args.status not in UPDATE_STATUS_PERMISSIONS[args.actor]:
                raise SystemExit(f"backlog-agent cannot set agile_status={args.status}")
            if (
                args.current_subagent is not None
                and args.current_subagent not in CURRENT_SUBAGENT_PERMISSIONS[args.actor]
            ):
                raise SystemExit(
                    f"backlog-agent cannot assign current_subagent={args.current_subagent}"
                )
        if row["agile_status"] == "blocked" and args.status not in (None, "blocked"):
            raise SystemExit(
                "blocked tasks must be restored with block-release before another status transition"
            )
        prospective = dict(row)
        if args.status is not None:
            prospective["agile_status"] = args.status
        if args.current_subagent is not None:
            prospective["current_subagent"] = args.current_subagent
        if args.blocked_reason is not None:
            prospective["blocked_reason"] = args.blocked_reason
        validate_status_transition(row, args.status)
        validate_pipeline_state(prospective, args.task_id)
        ensure_single_active_code_slot(conn, args.task_id, args.status)

        if row["work_dir"]:
            work_dir = Path(row["work_dir"])
        else:
            day = args.date or date.today().strftime("%Y%m%d")
            slug = build_work_slug(row["title"], args.slug)
            work_dir = Path(".project") / kind_to_dir[args.kind] / f"{day}-{slug}"
        attachments = work_dir / "attachments"
        attachments.mkdir(parents=True, exist_ok=True)

        init_input = work_dir / "01_init_input.md"
        local_questions = work_dir / "90_questions.md"

        if not init_input.exists():
            init_input.write_text(
                "\n".join(
                    [
                        "# Initial Input",
                        "",
                        "## Source",
                        "",
                        f"- Task ID: {row['task_id']}",
                        f"- Original URL: {row['link'] or ''}",
                        f"- External ID: {row['external_id'] or ''}",
                        f"- External Status: {row['external_status'] or ''}",
                        f"- Priority: {row['priority'] or ''}",
                        "",
                        "## Raw Title",
                        "",
                        row["title"] or "",
                        "",
                        "## Raw Body / Comments / Attachments",
                        "",
                        "待 backlog-agent 从原始 URL 收集正文、评论、显式附件和页面内嵌图片。",
                        "",
                        "## Attachment Index",
                        "",
                        "| 本地文件 | 类型 | 来源位置 | 原始 URL | 尺寸/大小 | 说明 |",
                        "|---|---|---|---|---|---|",
                        '| 待收集 | 待收集 | 待收集 | 待收集 | 待收集 | backlog-agent 必须优先下载显式附件和页面内嵌图片原图；如果没有图片，改为记录"未发现页面内嵌图片或显式附件"。 |',
                        "",
                        "## Collection Notes",
                        "",
                        "- 图片采集状态：待收集",
                        "- 图片质量要求：优先保存 original，不要用低清截图替代可访问原图。",
                        "- 登录态图片应优先通过浏览器上下文 fetch/blob、原图链接或下载按钮保存原图。",
                        "- 截图只允许作为 degraded fallback，并必须说明原图无法获取的原因。",
                        "- 如果图片既不能下载原图也不能截图，应记录失败原因并写入当前工作目录的 `90_questions.md`。",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

        if not local_questions.exists():
            local_questions.write_text(
                "\n".join(
                    [
                        "# 90 Questions",
                        "",
                        "这个文件用于当前工作目录级的通用 human-in-the-loop 问题。",
                        "",
                        "## 待确认",
                        "",
                        "story 级业务分析问题写入 stories/<story>/90_analysis_questions.md；测试上下文问题写入 stories/<story>/91_test_questions.md。",
                        "",
                        "## 已确认",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

        conn.execute(
            """
            UPDATE tasks
            SET item_type = ?, work_dir = ?, agile_status = COALESCE(?, agile_status),
                current_subagent = COALESCE(?, current_subagent),
                next_step = COALESCE(?, next_step),
                blocked_reason = COALESCE(?, blocked_reason),
                last_actor = ?,
                resume_pending = 0,
                resume_status = CASE
                  WHEN ? = 'blocked' AND agile_status != 'blocked' THEN agile_status
                  WHEN ? IS NOT NULL AND ? != 'blocked' THEN NULL
                  ELSE resume_status
                END,
                updated_at = datetime('now')
            WHERE task_id = ?
            """,
            (
                args.kind,
                str(work_dir),
                args.status,
                args.current_subagent,
                args.next_step,
                args.blocked_reason,
                args.actor,
                args.status,
                args.status,
                args.status,
                args.task_id,
            ),
        )
        updated_row = fetch_task(conn, args.task_id)

    if updated_row is not None:
        if args.status == "blocked":
            write_block_file(updated_row)
        elif args.status is not None:
            clear_block_file(updated_row)
        write_loop_state_file(updated_row)

    print(work_dir)



def run_question_add(args: argparse.Namespace) -> None:
    question_id = args.question_id or f"Q-{uuid.uuid4().hex[:8]}"
    is_local_questions = False
    if args.questions_file:
        questions_path = Path(args.questions_file)
    elif args.work_dir:
        questions_path = Path(args.work_dir) / default_questions_file_for_task(args)
        is_local_questions = True
    else:
        raise SystemExit("--work-dir is required (or pass --questions-file explicitly)")
    questions_path.parent.mkdir(parents=True, exist_ok=True)
    if not questions_path.exists():
        title = question_file_title(questions_path) if is_local_questions else "# Questions"
        questions_path.write_text(f"{title}\n\n## 待确认\n\n## 已确认\n\n", encoding="utf-8")

    block = "\n".join(
        [
            "",
            f"### {question_id}：{args.title or args.task_id or '待确认问题'}",
            "",
            f"- Task ID：{args.task_id or ''}",
            f"- 本地目录：{args.work_dir or ''}",
            "- Agile 状态：blocked",
            f"- 阻塞原因：{args.blocked_reason or ''}",
            f"- 问题：{args.question}",
            f"- 为什么问：{args.why or ''}",
            f"- 推荐答案：{args.recommendation or ''}",
            "- 你的答复：",
            "",
        ]
    )
    text = questions_path.read_text(encoding="utf-8")
    marker = "\n## 已确认"
    if marker in text:
        text = text.replace(marker, block + marker, 1)
    else:
        text = text.rstrip() + block + "\n"
    questions_path.write_text(text, encoding="utf-8")
    print(question_id)


def default_questions_file_for_task(args: argparse.Namespace) -> str:
    current_subagent = ""
    if args.task_id:
        with connect(Path(args.db)) as conn:
            row = fetch_task(conn, args.task_id)
        if row is not None:
            current_subagent = row["current_subagent"] or ""

    if current_subagent == "analyst-agent":
        return "90_analysis_questions.md"
    if current_subagent == "test-agent":
        return "91_test_questions.md"
    return "90_questions.md"


def question_file_title(path: Path) -> str:
    if path.name == "90_analysis_questions.md":
        return "# 90 Analysis Questions"
    if path.name == "91_test_questions.md":
        return "# 91 Test Questions"
    return "# 90 Questions"


def block_file_for_row(row) -> Path:
    if row["work_dir"]:
        return Path(row["work_dir"]) / "block.md"
    return DEFAULT_BLOCK_DIR / f"{row['task_id']}.md"


def write_block_file(row) -> None:
    path = block_file_for_row(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# Blocked",
                "",
                f"- Task ID: {row['task_id']}",
                f"- Title: {row['title'] or ''}",
                f"- Current Subagent: {row['current_subagent'] or ''}",
                f"- Resume Status: {row['resume_status'] or ''}",
                f"- Resume Pending: {row['resume_pending']}",
                f"- Blocked Reason: {row['blocked_reason'] or ''}",
                f"- Approval File: {row['approval_file'] or ''}",
                f"- Next Step: {row['next_step'] or ''}",
                f"- Updated At: {row['updated_at'] or ''}",
                "",
                "## 解除方式",
                "",
                "阻塞解决后，不要手动删除本文件。请执行：",
                "",
                "```bash",
                f"python scripts/loop/loopctl.py block-release {row['task_id']}",
                "```",
                "",
            ]
        ),
        encoding="utf-8",
    )


def clear_block_file(row, create: bool = False) -> None:
    path = block_file_for_row(row)
    if path.exists() or create:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")


def write_loop_state_file(row) -> None:
    if not row["work_dir"]:
        return
    work_dir = Path(row["work_dir"])
    if not work_dir.exists():
        return
    path = work_dir / "00_loop_state.md"
    path.write_text(
        "\n".join(
            [
                "# Loop State",
                "",
                "本文件由 loopctl 自动维护。agent 不应手写或手动同步本文件。",
                "",
                f"- Task ID: {row['task_id']}",
                f"- Title: {row['title'] or ''}",
                f"- 类型: {row['item_type'] or ''}",
                f"- Agile 状态: {row['agile_status']}",
                f"- Resume Status: {row['resume_status'] or ''}",
                f"- 当前 Subagent: {row['current_subagent'] or ''}",
                f"- Analysis Approved Index: {row['analysis_approved_index']}",
                f"- Review Approved: {row['review_approved']}",
                f"- Approval File: {row['approval_file'] or ''}",
                f"- Last Actor: {row['last_actor'] or ''}",
                f"- Analysis Index: {row['analysis_index']}",
                f"- Dev Index: {row['dev_index']}",
                f"- Test Index: {row['test_index']}",
                f"- Total Stories: {row['total_stories']}",
                f"- Next Step: {row['next_step'] or ''}",
                f"- Blocked Reason: {row['blocked_reason'] or ''}",
                f"- 原始 URL: {row['link'] or ''}",
                f"- 本地目录: {row['work_dir']}",
                f"- 最近更新: {date.today().isoformat()}",
                "",
            ]
        ),
        encoding="utf-8",
    )


def fetch_task(conn: sqlite3.Connection, task_id: str):
    return conn.execute(
        """
        SELECT task_id, title, link, external_id, external_status, item_type,
               priority, agile_status, current_subagent,
               analysis_index, dev_index, test_index, total_stories,
               next_step, work_dir, blocked_reason, resume_status, resume_pending,
               analysis_approved_index, review_approved, approval_file, last_actor,
               owner, evidence, risk, updated_at
        FROM tasks WHERE task_id = ?
        """,
        (task_id,),
    ).fetchone()


def run_block_release(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        row = fetch_task(conn, args.task_id)
        if row is None:
            raise SystemExit(f"task not found: {args.task_id}")
        if row["agile_status"] != "blocked":
            raise SystemExit(f"task is not blocked: {args.task_id}")
        if args.resume_status and row["resume_status"] and args.resume_status != row["resume_status"]:
            raise SystemExit(
                f"resume_status is already recorded as {row['resume_status']}; "
                "explicit override is only allowed for legacy rows with no resume_status"
            )
        resume_status = args.resume_status or row["resume_status"]
        if not resume_status or resume_status == "blocked":
            raise SystemExit(
                "blocked task has no valid resume_status; pass --resume-status explicitly"
            )
        if not row["current_subagent"]:
            raise SystemExit(
                "blocked task has no current_subagent; set it with task-update before release"
            )
        analysis_approved_index = row["analysis_approved_index"]
        review_approved = row["review_approved"]
        next_step_detail = ""
        if row["current_subagent"] in {"analyst-agent", "review-agent"}:
            if not row["approval_file"]:
                raise SystemExit(
                    f"{row['current_subagent']} block has no approval_file; "
                    "set the correct approval file before release"
                )
            decision = read_approval_decision(
                row["approval_file"], row["current_subagent"]
            )
            if decision == "pending":
                raise SystemExit(
                    f"human decision is still pending in {row['approval_file']}"
                )
            if row["current_subagent"] == "analyst-agent":
                if decision == "confirmed":
                    analysis_approved_index = max(
                        analysis_approved_index, row["analysis_index"] + 1
                    )
                    if analysis_approved_index > row["total_stories"]:
                        raise SystemExit("analysis approval exceeds total_stories")
                    next_step_detail = "人工已确认当前 story 分析决策"
                else:
                    next_step_detail = "人工要求继续澄清，不得推进 analysis_index"
            elif decision == "approved":
                review_approved = 1
                next_step_detail = "人工已批准交付"
            else:
                review_approved = 0
                next_step_detail = "人工要求修改，必须执行 task-rewind"
        prospective = dict(row)
        prospective["agile_status"] = resume_status
        prospective["analysis_approved_index"] = analysis_approved_index
        prospective["review_approved"] = review_approved
        validate_pipeline_state(prospective, args.task_id)
        ensure_single_active_code_slot(conn, args.task_id, resume_status)
        next_step = f"阻塞已解除，交回 {row['current_subagent'] or 'pipeline'} 继续处理"
        if next_step_detail:
            next_step = f"{next_step}；{next_step_detail}"
        conn.execute(
            """
            UPDATE tasks
            SET agile_status = ?, resume_status = NULL, resume_pending = 1, blocked_reason = NULL,
                analysis_approved_index = ?, review_approved = ?,
                next_step = ?, last_actor = 'human', updated_at = datetime('now')
            WHERE task_id = ?
            """,
            (
                resume_status,
                analysis_approved_index,
                review_approved,
                next_step,
                args.task_id,
            ),
        )
        updated = fetch_task(conn, args.task_id)
    clear_block_file(updated, create=True)
    write_loop_state_file(updated)
    print(f"released {args.task_id}")


def run_block_list(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        rows = conn.execute(
            """
            SELECT task_id, title, link, external_id, external_status, item_type,
                   priority, agile_status, current_subagent,
                   analysis_index, dev_index, test_index, total_stories,
                   next_step, work_dir, blocked_reason, resume_status, resume_pending,
                   analysis_approved_index, review_approved, approval_file, last_actor,
                   owner, evidence, risk, updated_at
            FROM tasks
            WHERE agile_status = 'blocked'
            ORDER BY updated_at DESC
            """
        ).fetchall()

    active = []
    for row in rows:
        path = block_file_for_row(row)
        if not path.exists() or path.stat().st_size == 0:
            write_block_file(row)
        active.append(
            {
                "task_id": row["task_id"],
                "title": row["title"] or "",
                "current_subagent": row["current_subagent"] or "",
                "work_dir": row["work_dir"] or "",
                "block_file": str(path),
                "approval_file": row["approval_file"] or "",
                "blocked_reason": row["blocked_reason"] or "",
                "next_step": row["next_step"] or "",
                "updated_at": row["updated_at"] or "",
            }
        )

    if args.format == "jsonl":
        for item in active:
            print(json.dumps(item, ensure_ascii=False))
        return

    if not active:
        print("No active blocked tasks.")
        return

    print("## Blocked Tasks")
    print("")
    for item in active:
        print(f"- {item['title']} ({item['task_id']})")
        print(f"  - Agent: {item['current_subagent']}")
        print(f"  - Work Dir: {item['work_dir']}")
        print(f"  - Block File: {item['block_file']}")
        if item["approval_file"]:
            print(f"  - Approval File: {item['approval_file']}")
        print(f"  - Reason: {item['blocked_reason']}")
        print(f"  - Next Step: {item['next_step']}")
        print(f"  - Release: python scripts/loop/loopctl.py block-release {item['task_id']}")
        print("")


def pipeline_field(value: object) -> str:
    """Keep pipeline output parseable as pipe-delimited text."""
    return str(value or "").replace("|", "／").replace("\n", " ").strip()


def pipeline_envelope(row, pipe: str, agent: str, story_index: int | str | None, description: str) -> dict[str, object]:
    story = None if story_index in (None, "") else int(story_index)
    resource = "browser" if agent in BROWSER_RESOURCE_AGENTS else "none"
    return {
        "task_id": row["task_id"],
        "title": row["title"] or "",
        "item_type": row["item_type"] or "other",
        "priority": row["priority"] or "",
        "link": row["link"] or "",
        "external_id": row["external_id"] or "",
        "external_status": row["external_status"] or "",
        "agile_status": row["agile_status"],
        "pipeline": pipe,
        "agent": agent,
        "resource": resource,
        "current_subagent": row["current_subagent"] or "",
        "resume_pending": row["resume_pending"],
        "analysis_approved_index": row["analysis_approved_index"],
        "review_approved": row["review_approved"],
        "approval_file": row["approval_file"] or "",
        "last_actor": row["last_actor"] or "",
        "work_dir": row["work_dir"] or "",
        "story_index": story,
        "analysis_index": row["analysis_index"],
        "dev_index": row["dev_index"],
        "test_index": row["test_index"],
        "total_stories": row["total_stories"],
        "next_step": row["next_step"] or "",
        "blocked_reason": row["blocked_reason"] or "",
        "owner": row["owner"] or "",
        "evidence": row["evidence"] or "",
        "risk": row["risk"] or "",
        "description": description,
    }


def render_pipeline(item: dict[str, object], output_format: str) -> str:
    if output_format == "jsonl":
        return json.dumps(item, ensure_ascii=False)
    return "|".join(
        [
            pipeline_field(item["task_id"]),
            pipeline_field(item["title"]),
            pipeline_field(item["work_dir"]),
            pipeline_field(item["pipeline"]),
            pipeline_field(item["agent"]),
            pipeline_field(item["story_index"] or ""),
            pipeline_field(item["description"]),
        ]
    )


def row_occupies_code_slot(row) -> bool:
    return row["agile_status"] in {"in dev", "in review"} or (
        row["agile_status"] == "blocked"
        and (row["resume_status"] in {"in dev", "in review"} or row["current_subagent"] == "review-agent")
    )


def pipeline_for_task(row, code_slot_available: bool = True) -> list[dict[str, object]]:
    """Compute delegation envelopes for a single task row."""
    t = row["test_index"]
    d = row["dev_index"]
    a = row["analysis_index"]
    total = row["total_stories"]
    status = row["agile_status"]

    def line(pipe: str, agent: str, story_index: int | str | None, description: str) -> dict[str, object]:
        return pipeline_envelope(row, pipe, agent, story_index, description)

    lines = []

    if status in {"done", "cancelled"}:
        return lines  # skip terminal tasks

    if status == "blocked":
        return lines
    if row["resume_pending"]:
        agent = row["current_subagent"]
        story_index = None
        if agent == "analyst-agent" and a < total:
            story_index = a + 1
        elif agent == "dev-agent" and d < a:
            story_index = d + 1
        elif agent == "test-agent" and t < d:
            story_index = t + 1
        lines.append(line("resume", agent, story_index, "consume human input and resume safely"))
        return lines
    elif status == "backlog":
        lines.append(line("backlog", "backlog-agent", "", "collect context and classify"))
    elif status == "in repro":
        lines.append(line("repro", "repro-agent", "", "reproduce bug and root cause"))
    elif status == "in plan":
        lines.append(line("split", "story-splitter-agent", "", "decompose into stories"))
    elif status == "ready for dev":
        if d < a and code_slot_available:
            lines.append(line("dev", "dev-agent", d + 1, f"story-{d + 1} development; claim code slot"))
        elif a < total:
            lines.append(line("analysis", "analyst-agent", a + 1, f"story-{a + 1} requirements + plan"))
        elif total == 0:
            lines.append(line("split", "story-splitter-agent", "", "decompose into stories"))
    elif status == "in review":
        lines.append(line("review", "review-agent", "", "aggregate all stories for delivery"))
    else:
        # A task advances by one safe step per loop. Test before starting more
        # development so a failed earlier story cannot race with later code
        # changes; analysis runs when no developed/testable work is pending.
        if t == d == a == total and total > 0:
            lines.append(line("review", "review-agent", "", "all stories done, ready for review"))
        else:
            if t < d:
                lines.append(line("test", "test-agent", t + 1, f"story-{t + 1} black-box testing"))
            elif d < a:
                lines.append(line("dev", "dev-agent", d + 1, f"story-{d + 1} development"))
            elif a < total:
                lines.append(line("analysis", "analyst-agent", a + 1, f"story-{a + 1} requirements + plan"))
            elif total == 0:
                lines.append(line("split", "story-splitter-agent", "", "decompose into stories"))

    return lines


def run_task_pipeline(args: argparse.Namespace) -> None:
    """Output the delegation plan for a single task."""
    with connect(Path(args.db)) as conn:
        row = conn.execute(
            """
            SELECT task_id, title, link, external_id, external_status, item_type,
                   priority, agile_status, current_subagent,
                   analysis_index, dev_index, test_index, total_stories,
                   next_step, work_dir, blocked_reason, resume_status, resume_pending,
                   analysis_approved_index, review_approved, approval_file, last_actor,
                   owner, evidence, risk
            FROM tasks WHERE task_id = ?
            """,
            (args.task_id,),
        ).fetchone()
        all_rows = conn.execute(
            """
            SELECT task_id, title, link, external_id, external_status, item_type,
                   priority, agile_status, current_subagent,
                   analysis_index, dev_index, test_index, total_stories,
                   next_step, work_dir, blocked_reason, resume_status, resume_pending,
                   analysis_approved_index, review_approved, approval_file, last_actor,
                   owner, evidence, risk
            FROM tasks
            WHERE agile_status NOT IN ('done', 'cancelled')
            """
        ).fetchall()
    if row is None:
        raise SystemExit(f"task not found: {args.task_id}")
    code_slot_available = not any(
        other["task_id"] != args.task_id and row_occupies_code_slot(other)
        for other in all_rows
    )
    for item in pipeline_for_task(row, code_slot_available=code_slot_available):
        print(render_pipeline(item, args.format))


def run_pipeline_all(args: argparse.Namespace) -> None:
    """Output delegation plans for all active tasks in one call."""
    require_run_lease(Path(args.db), args.run_token)
    if inbox_has_changes(Path(args.db)):
        print(render_pipeline(source_envelope(), args.format))

    with connect(Path(args.db)) as conn:
        rows = conn.execute(
            """
            SELECT task_id, title, link, external_id, external_status, item_type,
                   priority, agile_status, current_subagent,
                   analysis_index, dev_index, test_index, total_stories,
                   next_step, work_dir, blocked_reason, resume_status, resume_pending,
                   analysis_approved_index, review_approved, approval_file, last_actor,
                   owner, evidence, risk
            FROM tasks
            WHERE agile_status NOT IN ('done', 'cancelled')
            ORDER BY
              CASE agile_status
                WHEN 'blocked' THEN 0
                WHEN 'in dev' THEN 1
                WHEN 'in review' THEN 2
                WHEN 'in plan' THEN 4
                WHEN 'in repro' THEN 5
                WHEN 'backlog' THEN 6
                ELSE 7
              END,
              CASE upper(COALESCE(priority, ''))
                WHEN 'P0' THEN 0 WHEN 'S0' THEN 0
                WHEN 'P1' THEN 1 WHEN 'S1' THEN 1
                WHEN 'P2' THEN 2 WHEN 'S2' THEN 2
                WHEN 'P3' THEN 3 WHEN 'S3' THEN 3
                ELSE 9
              END,
              updated_at DESC
            """
        ).fetchall()
    browser_used = False
    code_slot_available = not any(row_occupies_code_slot(row) for row in rows)
    ready_dev_task_id = None
    if code_slot_available:
        with connect(Path(args.db)) as conn:
            ready_row = conn.execute(
                """
                SELECT task_id
                FROM tasks
                WHERE agile_status = 'ready for dev'
                  AND dev_index < analysis_index
                ORDER BY random()
                LIMIT 1
                """
            ).fetchone()
        ready_dev_task_id = ready_row["task_id"] if ready_row else None
    for row in rows:
        row_code_slot_available = code_slot_available
        if row["agile_status"] == "ready for dev" and row["dev_index"] < row["analysis_index"]:
            row_code_slot_available = code_slot_available and row["task_id"] == ready_dev_task_id
        for item in pipeline_for_task(row, code_slot_available=row_code_slot_available):
            if item["pipeline"] == "dev" and row["agile_status"] == "ready for dev":
                code_slot_available = False
            if item["resource"] == "browser":
                if browser_used:
                    continue
                browser_used = True
            print(render_pipeline(item, args.format))


def run_status(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        rows = conn.execute(
            "SELECT agile_status, COUNT(*) AS count FROM tasks GROUP BY agile_status ORDER BY agile_status"
        ).fetchall()
    print("tasks:")
    for row in rows:
        print(f"  {row['agile_status']}: {row['count']}")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def read_run_lease(conn: sqlite3.Connection) -> tuple[str, datetime | None]:
    rows = conn.execute(
        "SELECT key, value FROM meta WHERE key IN ('run_token', 'run_lease_until')"
    ).fetchall()
    values = {row["key"]: row["value"] for row in rows}
    return values.get("run_token", ""), parse_utc(values.get("run_lease_until"))


def write_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        """,
        (key, value),
    )


def run_run_begin(args: argparse.Namespace) -> None:
    if not 1 <= args.lease_minutes <= 1440:
        raise SystemExit("--lease-minutes must be between 1 and 1440")
    now = utc_now()
    token = uuid.uuid4().hex
    lease_until = now + timedelta(minutes=args.lease_minutes)
    with connect(Path(args.db)) as conn:
        conn.execute("BEGIN IMMEDIATE")
        active_token, active_until = read_run_lease(conn)
        if active_token and active_until and active_until > now:
            remaining = int((active_until - now).total_seconds() // 60) + 1
            raise SystemExit(
                f"busy: another loop run is active for about {remaining} more minute(s)"
            )
        write_meta(conn, "run_token", token)
        write_meta(conn, "run_lease_until", lease_until.isoformat())
    print(token)


def require_run_lease(db_path: Path, token: str) -> None:
    with connect(db_path) as conn:
        active_token, active_until = read_run_lease(conn)
    if not active_token or token != active_token:
        raise SystemExit("invalid or inactive run token; call run-begin first")
    if not active_until or active_until <= utc_now():
        raise SystemExit("run lease expired; start a new loop run")


def run_run_end(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        conn.execute("BEGIN IMMEDIATE")
        active_token, _ = read_run_lease(conn)
        if not active_token:
            print("no active loop run")
            return
        if not args.force and args.token != active_token:
            raise SystemExit("run token does not own the active lease")
        write_meta(conn, "run_token", "")
        write_meta(conn, "run_lease_until", "")
    print("loop run released")


def run_run_status(args: argparse.Namespace) -> None:
    with connect(Path(args.db)) as conn:
        token, lease_until = read_run_lease(conn)
    if token and lease_until and lease_until > utc_now():
        print(f"active until {lease_until.isoformat()}")
    elif token:
        print("expired")
    else:
        print("idle")


def file_md5(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.md5(path.read_bytes()).hexdigest()


def inbox_has_changes(db_path: Path, inbox_path: Path = DEFAULT_INBOX) -> bool:
    current = file_md5(inbox_path)
    if not current:
        return False
    with connect(db_path) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = 'inbox_md5'").fetchone()
    stored = row["value"] if row else ""
    return not stored or current != stored


def source_envelope() -> dict[str, object]:
    return {
        "task_id": "",
        "title": "Inbox changed",
        "item_type": "source",
        "priority": "",
        "link": "",
        "external_id": "",
        "external_status": "",
        "agile_status": "",
        "pipeline": "source",
        "agent": "source-agent",
        "resource": "none",
        "current_subagent": "",
        "resume_pending": 0,
        "analysis_approved_index": 0,
        "review_approved": 0,
        "approval_file": "",
        "last_actor": "loopctl",
        "work_dir": ".project/_loop",
        "story_index": None,
        "analysis_index": 0,
        "dev_index": 0,
        "test_index": 0,
        "total_stories": 0,
        "next_step": "process changed inbox.md",
        "blocked_reason": "",
        "owner": "",
        "evidence": "inbox.md md5 changed",
        "risk": "new tasks will be routed on the next loop run after source-agent commits inbox md5",
        "description": "process changed inbox.md",
    }


def run_inbox_check(args: argparse.Namespace) -> None:
    """Compare inbox.md MD5 against last committed value. Exit 0 = unchanged, exit 1 = changed or no prior commit."""
    inbox = Path(args.inbox)
    current = file_md5(inbox)
    if not current:
        print("missing")
        raise SystemExit(1)
    with connect(Path(args.db)) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = 'inbox_md5'").fetchone()
    stored = row["value"] if row else ""
    if stored and current == stored:
        print("unchanged")
        raise SystemExit(0)
    else:
        print("changed")
        raise SystemExit(1)


def run_inbox_commit(args: argparse.Namespace) -> None:
    """Save current inbox.md MD5 to meta table after successful processing."""
    inbox = Path(args.inbox)
    current = file_md5(inbox)
    if not current:
        raise SystemExit(f"inbox not found: {inbox}")
    with connect(Path(args.db)) as conn:
        conn.execute(
            """
            INSERT INTO meta(key, value) VALUES ('inbox_md5', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            """,
            (current,),
        )
    print(f"committed {current}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="loopctl")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("init")
    p.add_argument("--schema", default=str(DEFAULT_SCHEMA))
    p.set_defaults(func=run_init)

    p = sub.add_parser("status")
    p.set_defaults(func=run_status)

    p = sub.add_parser("run-begin")
    p.add_argument("--lease-minutes", type=int, default=120)
    p.set_defaults(func=run_run_begin)

    p = sub.add_parser("run-end")
    p.add_argument("token", nargs="?")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=run_run_end)

    p = sub.add_parser("run-status")
    p.set_defaults(func=run_run_status)

    p = sub.add_parser("inbox-check")
    p.add_argument("--inbox", default=str(DEFAULT_INBOX))
    p.set_defaults(func=run_inbox_check)

    p = sub.add_parser("inbox-commit")
    p.add_argument("--inbox", default=str(DEFAULT_INBOX))
    p.set_defaults(func=run_inbox_commit)

    p = sub.add_parser("task-add")
    p.add_argument("--actor", choices=ACTORS, required=True)
    p.add_argument("--task-id")
    p.add_argument("--title", required=True)
    p.add_argument("--link")
    p.add_argument("--external-id")
    p.add_argument("--item-type", default="other")
    p.add_argument("--priority")
    p.add_argument("--external-status")
    p.add_argument("--status", choices=AGILE_STATUSES, default="backlog")
    p.add_argument("--current-subagent")
    p.add_argument("--analysis-index", type=int, default=0)
    p.add_argument("--dev-index", type=int, default=0)
    p.add_argument("--test-index", type=int, default=0)
    p.add_argument("--total-stories", type=int, default=0)
    p.add_argument("--next-step")
    p.add_argument("--blocked-reason")
    p.set_defaults(func=run_task_add)

    p = sub.add_parser("task-ingest")
    p.add_argument("--actor", choices=ACTORS, required=True)
    p.add_argument("--task-id")
    p.add_argument("--title", required=True)
    p.add_argument("--link", required=True)
    p.add_argument("--external-id")
    p.add_argument("--item-type", default="other")
    p.add_argument("--priority")
    p.add_argument("--external-status")
    p.add_argument("--status", choices=AGILE_STATUSES, default="backlog")
    p.add_argument("--current-subagent")
    p.add_argument("--analysis-index", type=int, default=0)
    p.add_argument("--dev-index", type=int, default=0)
    p.add_argument("--test-index", type=int, default=0)
    p.add_argument("--total-stories", type=int, default=0)
    p.add_argument("--next-step", default="收集上下文并定位任务类型")
    p.add_argument("--blocked-reason")
    p.set_defaults(func=run_task_ingest)

    p = sub.add_parser("task-list")
    p.add_argument("--status", choices=AGILE_STATUSES)
    p.add_argument("--all", action="store_true")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=run_task_list)

    p = sub.add_parser("task-url-list")
    p.set_defaults(func=run_task_url_list)

    p = sub.add_parser("task-get")
    p.add_argument("task_id")
    p.set_defaults(func=run_task_get)

    p = sub.add_parser("task-pipeline")
    p.add_argument("task_id")
    p.add_argument("--format", choices=["jsonl", "pipe"], default="jsonl")
    p.set_defaults(func=run_task_pipeline)

    p = sub.add_parser("pipeline-all")
    p.add_argument("--run-token", required=True)
    p.add_argument("--format", choices=["jsonl", "pipe"], default="jsonl")
    p.set_defaults(func=run_pipeline_all)

    p = sub.add_parser("block-list")
    p.add_argument("--format", choices=["markdown", "jsonl"], default="markdown")
    p.set_defaults(func=run_block_list)

    p = sub.add_parser("block-release")
    p.add_argument("task_id")
    p.add_argument(
        "--resume-status",
        choices=[s for s in AGILE_STATUSES if s not in {"blocked", "done", "cancelled"}],
    )
    p.set_defaults(func=run_block_release)

    p = sub.add_parser("task-update")
    p.add_argument("task_id")
    p.add_argument("--actor", choices=ACTORS, required=True)
    p.add_argument("--title")
    p.add_argument("--status", choices=AGILE_STATUSES)
    p.add_argument("--current-subagent")
    p.add_argument("--analysis-index", type=int)
    p.add_argument("--dev-index", type=int)
    p.add_argument("--test-index", type=int)
    p.add_argument("--total-stories", type=int)
    p.add_argument("--next-step")
    p.add_argument("--blocked-reason")
    p.add_argument("--work-dir")
    p.add_argument("--item-type")
    p.add_argument("--priority")
    p.add_argument("--approval-file")
    p.set_defaults(func=run_task_update)

    p = sub.add_parser("task-rewind")
    p.add_argument("task_id")
    p.add_argument("--actor", choices=ACTORS, required=True)
    p.add_argument("--to", choices=["plan", "analysis", "dev", "test"], required=True)
    p.add_argument("--story", type=int)
    p.add_argument("--reason")
    p.set_defaults(func=run_task_rewind)

    p = sub.add_parser("task-cancel")
    p.add_argument("task_id")
    p.add_argument("--reason", required=True)
    p.add_argument("--confirm-code-clean", action="store_true")
    p.set_defaults(func=run_task_cancel)

    p = sub.add_parser("task-context-init")
    p.add_argument("task_id")
    p.add_argument("--actor", choices=ACTORS, required=True)
    p.add_argument("--kind", choices=["feature", "bug", "tech", "intake"], default="intake")
    p.add_argument("--date")
    p.add_argument("--slug")
    p.add_argument("--status", choices=AGILE_STATUSES)
    p.add_argument("--current-subagent")
    p.add_argument("--next-step")
    p.add_argument("--blocked-reason")
    p.set_defaults(func=run_task_context_init)

    p = sub.add_parser("question-add")
    p.add_argument("--question-id")
    p.add_argument("--task-id")
    p.add_argument("--title")
    p.add_argument("--work-dir")
    p.add_argument("--blocked-reason")
    p.add_argument("--question", required=True)
    p.add_argument("--why")
    p.add_argument("--recommendation")
    p.add_argument("--questions-file")
    p.set_defaults(func=run_question_add)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
