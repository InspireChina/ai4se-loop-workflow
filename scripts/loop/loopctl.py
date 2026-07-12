#!/usr/bin/env python3
"""Compatibility shim for the TypeScript Loop Engineering CLI."""

from __future__ import annotations

import subprocess
import sys
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "loop" / "loopctl.ts"


def load_env_file(path: Path, env: dict[str, str], explicit: set[str]) -> None:
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in explicit:
            continue
        env[key] = value.strip().strip("\"'")


def main() -> int:
    env = os.environ.copy()
    explicit = set(env)
    load_env_file(ROOT / ".env", env, explicit)
    load_env_file(ROOT / ".env.local", env, explicit)
    command = ["npx", "tsx", str(SCRIPT), *sys.argv[1:]]
    return subprocess.call(command, cwd=ROOT, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
