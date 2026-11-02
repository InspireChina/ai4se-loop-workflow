#!/usr/bin/env bash
set -euo pipefail

# Keep the invocation directory as the single OMP workspace.
export LOOP_WORKSPACE_ROOT="${LOOP_WORKSPACE_ROOT:-$PWD}"

# Resolve paths from this script so it can be launched from any directory.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20.9 或更新版本。" >&2
  exit 1
fi

if [[ ! -d node_modules/tsx || ! -d node_modules/next || ! -d node_modules/better-sqlite3 ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "请先安装 npm，用于安装项目依赖。" >&2
    exit 1
  fi
  echo "正在安装项目依赖……"
  npm ci
fi

# Replace the shell so Ctrl+C/SIGTERM reaches the Web service directly.
exec node --import tsx scripts/web-server.ts "$@"
