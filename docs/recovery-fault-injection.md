# Recovery fault injection

This entry is acceptance tooling for the Admin-driven recovery loop. It must only be used with an isolated data root and disposable target repository. It is not a production executor and is intentionally excluded from Desktop runtime entrypoints.

## Safety gate

The wrapper refuses to run unless all of the following are explicit:

- `LOOP_RECOVERY_FAULT_ACK=I_UNDERSTAND_THIS_IS_RECOVERY_TEST_ONLY`
- `LOOP_RECOVERY_FAULT_MODE` is one supported mode.
- `LOOP_RECOVERY_FAULT_STATE` is an absolute path inside the isolated acceptance directory.
- `LOOP_EXECUTION_ID` is present, so injection is deterministic for one execution.
- For model-backed modes, `LOOP_RECOVERY_REAL_CLI` is an existing absolute executable path.

Put a symlink named for the configured executor (for example `cursor-agent`, `codex`, or `claude`) in the isolated test `PATH`; point that symlink at `scripts/recovery-fault-injection-agent.mjs`. Keep the real executable only in `LOOP_RECOVERY_REAL_CLI`. Never replace the user's global CLI. The wrapper preserves Cursor's file-reference argument and transparently appends to Codex/Claude/OMP stdin prompts.

`LOOP_RECOVERY_FAULT_LIMIT` defaults to 2 and accepts 1–100 per Agent role. The state file records the exact execution IDs selected for each mode and role. A retried wrapper process for the same execution receives the same fault; later executions beyond the limit are delegated unchanged. State updates are lock-protected and atomically renamed.

## Modes

| Mode | Target | Behavior |
|---|---|---|
| `dev-missing` | real Dev and Test | Dev deliberately makes no business change and claims completion; Test reruns `LOOP_RECOVERY_FAILURE_COMMAND` and preserves `LOOP_RECOVERY_FAILURE_SUMMARY` so repeated evidence is comparable. |
| `test-old-service` | real Dev and Test | Test uses `LOOP_RECOVERY_STALE_SERVICE_URL` as a deliberately stale runtime; Dev does not turn the version mismatch into an unrelated source edit. |
| `test-misjudgment` | real Dev and Test | Test uses an irrelevant failing check as a stable false implementation failure; Dev returns the healthy source unchanged. |
| `clean-exit-no-submit` | `LOOP_RECOVERY_FAULT_AGENT` | Synthetic CLI emits ordinary text and exits zero without a result. |
| `continuous-output` | `LOOP_RECOVERY_FAULT_AGENT` | Synthetic CLI keeps emitting non-progress output without a terminal result. |
| `crash-after-submit` | `LOOP_RECOVERY_FAULT_AGENT` | Synthetic CLI atomically writes the private result envelope, then exits 70. |

The first three modes still invoke the configured real Agent and are used for the three product recovery scenarios. The last three isolate execution/lifecycle timing before spending model calls.

## Evidence required for a passing scenario

Do not accept the wrapper's state file or a green Agent exit as recovery evidence. Preserve and independently check:

1. the injected execution IDs and original failure observations;
2. one continuing `RepairCase`, including strategy changes rather than a new first attempt;
3. physical exit of superseded CLI/Runner/Admin processes before conflicting writes;
4. actual Admin repair changes or environment correction;
5. independent rerun of every original failure and acceptance target against the repaired version;
6. physical handback followed by ordinary business progress;
7. no `agent-fault` intervention entering `awaiting_human`;
8. no duplicate result application, resource owner, or residual process barrier.

For the 8–12 hour run, sample these facts throughout the run and again after shutdown. A duration timer, test count, UI success state, or Case state transition alone is not acceptance.

Use the read-only audit after each scenario and after final shutdown:

```bash
npx tsx scripts/recovery-acceptance-audit.ts \
  --data-root /absolute/path/to/isolated-data \
  --case-id CASE_ID_FROM_THE_SCENARIO \
  --expect running \
  --output /absolute/path/to/evidence/running-audit.json
```

Repeat with `--expect stopped` after the host and Runner are stopped. `--case-id` accepts a comma-separated list. Omitting it is useful for diagnostics, but cannot prove that a requested Admin scenario created and closed its RepairCase. Exit code 2 means at least one invariant failed; the JSON still contains every violation.

The long observer enforces an actual 8–12 hour duration and writes an atomic checkpoint after every sample:

```bash
npx tsx scripts/recovery-soak-monitor.ts \
  --data-root /absolute/path/to/isolated-data \
  --case-id CASE_1,CASE_2,CASE_3 \
  --duration-hours 8 \
  --poll-seconds 30 \
  --output /absolute/path/to/evidence/overnight.json
```

It reopens both databases read-only for every sample, so a long-lived SQLite snapshot cannot hide progress. Any transient invariant violation remains in `violationOccurrences` even if the final state looks clean. `SIGINT`/`SIGTERM` writes an incomplete, interrupted checkpoint rather than manufacturing a shorter successful run. The final sample additionally requires every named Case to exist and satisfy the full closure audit.
