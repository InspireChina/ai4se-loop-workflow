---
name: workflow-commands
description: 在 LoopWork 活动执行中衔接现有命令链与工作目录脚本，保存真实检查结果并通过授权命令提交阶段证据。
---

从 `loopwork` 工具的 `status` 读取当前阶段、允许的命令和下一步。阶段顺序、回退和完成条件以返回的工作包为准，角色专业判断仍使用当前原生 Command 指令和相关业务 Skill。

工作目录的 `.omp/commands/` 维护同名 Markdown 专业指令和 CJS 命令链源码；`scripts/` 保留确定性配套工具。对应 Markdown 模板由业务 Skill 指向实际文件。命令链从 `.omp/commands/<agent-id>.cjs` 加载，角色校验与结果组装是该文件中的可执行函数，共享命令、阶段构造及状态操作源码在 `.omp/commands/workflow/*.cjs`。修改源码时保留 API v1 调度接口及固定角色绑定；入口和共享源码都可在 Agent 页面直接查看、修改、检查语法及保存。脚本默认保留原有阶段门禁，Workflow 仍负责执行授权、调度和结果应用。

执行检查时，可使用工作目录的通用辅助脚本（当前仓库已提供，其他工作目录需自行准备）：

```sh
node scripts/workflow/run-check.mjs --output "$LOOP_AGENT_TMP_DIR/checks" -- npm test
```

在 OMP 的 Bash 工具中调用。`--` 后是实际程序及各个参数，不进行 Shell 展开；需要管道时显式使用 `bash -o pipefail -c '...'`。脚本在指定目录下为每次检查创建独立子目录，实时输出并保存 `stdout.log`、`stderr.log`、`result.json`，失败或取消返回非零状态。退出码为零只证明该命令成功，是否满足验收仍需独立判断。

`LOOP_AGENT_TMP_DIR` 是本次执行临时目录，执行结束会清理。需要保留独立检查文件时，将 `--output` 指向工作目录中约定的产物文件夹，并按仓库规范处理 Git 忽略。后续通过领域命令提交的正文由 LoopWork 文件存储持久化，不能仅用一个即将被清理的路径作为最终证据。

检查完成后重新读取 `status`。需要 `check record` 的阶段，使用 Harness 捕获的当前 execution 真实 Shell receipt；`result.json` 是普通文件，不能充当 receipt ID，不能直接导入为权威检查记录。多条检查分别调用，每个必要检查单独登记；失败时保留输出，先修复或按工作包回退。

产物通过当前阶段允许的 `artifact put` 等命令提交；已有文本可以用 `loopwork` 工具的 `input` 配合 `@input` 提交，文件参数也可使用执行临时目录中的真实文件。提交后显式调用 `phase complete`，读取返回的工作包再继续。脚本不修改数据库、不自行推进阶段，也不自动提交代码或发布。
