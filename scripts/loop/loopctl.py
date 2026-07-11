#!/usr/bin/env python3
"""Compatibility shim for the TypeScript Loop Engineering CLI."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "loop" / "loopctl.ts"


def main() -> int:
    command = ["npx", "tsx", str(SCRIPT), *sys.argv[1:]]
    return subprocess.call(command, cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
