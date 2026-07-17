# Shared AI resources

Project-level AI resources live under this directory:

- `agents/`: canonical agent definitions
- `skills/`: canonical skill definitions
- `runs/`: runtime data and trace analysis outputs

Tool-specific directories outside `.ai/` are compatibility entry points and
should contain symlinks rather than independent copies.

Agent definitions are maintained as Markdown in `.ai/agents/`. Claude Code,
OpenCode, and Cursor consume those files directly; Codex consumes the generated
TOML adapters in the same directory. Regenerate Codex adapters after changing
an agent:

```bash
./.venv/bin/python scripts/agents/sync_agents.py
```
