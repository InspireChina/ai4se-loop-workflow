# Cursor Loop 正式初始化脚本

这个文件给 AI 在项目中初始化或升级 Cursor `/loop` 正式运行环境使用。

这套 loop 已从个人实验转为项目基础设施。初始化时要区分：

- 全局 Cursor 配置：subagent 按当前云桌面的 Cursor 配置方式安装到全局 agents 目录。
- 正式项目物料：`.cursor/commands/loop.md`、`.project/_loop/schema.sql`、`scripts/loop/loopctl.py` 和 `scripts/loop/README.md` 是需要版本化、发布和同步的基础设施。
- 项目运行态：`loop.db`、inbox MD5、任务工作目录、block 和审批文件在当前项目中运行，不与正式脚本混在一起。

当用户说“初始化 loop”或“按 init.md 初始化”时，按下面步骤执行。

## 0. 目录策略

### 0.1 全局目录

subagent 创建到 Cursor 全局 agents 目录：

```text
~/.cursor/agents/
```

需要复制：

```text
source-agent.md
backlog-agent.md
story-splitter-agent.md
analyst-agent.md
repro-agent.md
dev-agent.md
test-agent.md
review-agent.md
```

说明：

- 这些 agent 是 loop 正式运行依赖，更新模板后必须同步到实际 Cursor 全局 agents 目录。
- 如果用户的 Cursor 全局 agents 目录不是 `~/.cursor/agents/`，以用户实际环境为准。
- 不要再把 subagent 复制到目标项目的 `.cursor/agents/`。

### 0.2 项目目录

当前项目只创建 loop 运行所需目录：

```text
.cursor/commands/
.project/_loop/
.project/features/
.project/bugs/
.project/tech/
.project/intake/
.project/archive/features/
.project/archive/bugs/
.project/archive/tech/
scripts/loop/
```

说明：

- `.cursor/commands/loop.md` 是当前项目触发 `/loop` 的正式入口，使用项目根目录相对路径。
- `.project/_loop/` 是 loop 控制台和 SQLite 运行态。
- `.project/features/`、`.project/bugs/`、`.project/tech/`、`.project/intake/` 是 loop 生成的本地工作目录；每个具体工作目录会由 `loopctl task-context-init --actor backlog-agent` 创建 `00_loop_state.md`、`01_init_input.md`、`90_questions.md`。其中 `00_loop_state.md` 后续也只由 `loopctl` 自动刷新，agent 不手写；业务 agent 维护 `02_requirements.md`、`03_story_list.md`、story 子目录内的 `90_analysis_questions.md`、`91_test_questions.md`、`requirements.md`、`plan.md`、`40_test_plan.md`、`41_test_results.md`、`42_dev_response.md` 或 Bug 的 `20_repro_notes.md`；review-agent 维护父级 `06_review.md`。
- `.project/archive/features/`、`.project/archive/bugs/`、`.project/archive/tech/` 是 review 确认完成后的归档目录。
- `scripts/loop/` 是正式 loop CLI 及其使用文档，固定入口为 `python scripts/loop/loopctl.py`。

## 1. 创建目录

在目标项目根目录创建项目本地目录：

```bash
mkdir -p \
  .cursor/commands \
  .project/_loop \
  .project/features \
  .project/bugs \
  .project/tech \
  .project/intake \
  .project/archive/features \
  .project/archive/bugs \
  .project/archive/tech \
  scripts/loop
```

创建全局 agents 目录：

```bash
mkdir -p ~/.cursor/agents
```

## 2. 复制全局 Subagents

从模板目录复制 subagent 到全局目录：

```text
templates/customer-cloud-desktop/cursor-loop/.cursor/agents/*.md
-> ~/.cursor/agents/
```

复制后校验：

- 每个 agent 文件有 YAML frontmatter。
- `name` 和文件名一致。
- 不存在项目本地 `.cursor/agents/*.md` 副本，除非用户明确要项目级覆盖。

## 3. 复制项目本地 Loop 文件

从模板目录复制以下文件到目标项目：

```text
.cursor/commands/loop.md
.project/_loop/README.md
.project/_loop/control.md
.project/_loop/inbox.md
.project/_loop/schema.sql
scripts/loop/loopctl.py
scripts/loop/README.md
```

说明：

- `loop.db` 由 `loopctl init` 生成，不从模板复制。
- 四个工作目录只需要目录本身，README 不在第一版模板中；`.project/_loop/README.md` 保留，用于说明 inbox 示例和控制台用法。

## 4. 初始化 SQLite

在目标项目根目录执行：

```bash
python scripts/loop/loopctl.py init
```

成功后应生成：

```text
.project/_loop/loop.db
```

校验：

```bash
python scripts/loop/loopctl.py status
```

预期输出包含：

```text
tasks:
```

`init` 同时是幂等迁移命令。现有数据库会升级到 schema v23，新增 `analysis_approved_index`、`review_approved`、`approval_file` 和 `last_actor`。旧数据已完成的 analysis 游标会保留，但尚未完成的 review 必须按新的人工门禁重新确认。

## 5. 填写 Inbox

让用户编辑：

```text
.project/_loop/inbox.md
```

把当前想处理的卡片、Bug 或临时需求粘贴到 `## 新输入` 下。

第一版不实时扫描外部卡墙或 Bug 列表；新增任务不频繁时，手动把 URL 放进 inbox 更快、更可控。

## 6. 启动方式

在 Cursor Agent 输入框输入：

```text
/loop
```

`/loop` 只读取控制文件并调用 CLI：

```text
.project/_loop/control.md
```

`loop.db`、inbox MD5、Agile 状态、游标、代码槽和路由都由 `loopctl` 读取和计算；`/loop` 不直接读取数据库、inbox 或任何具体任务目录。每轮先用 `run-begin` 领取防重入租约，再调用 `pipeline-all --run-token <token>`，汇报前用 `run-end <token>` 释放。

当前状态与 agent 对应关系：

| 状态 | Agent |
|---|---|
| inbox 手动输入入库 | source-agent |
| backlog | backlog-agent |
| in plan | story-splitter-agent |
| in repro | repro-agent |
| ready for dev | analyst-agent 做 story 分析；已有分析产物且代码槽空闲时，pipeline-all 随机交给一个 dev-agent 开发 |
| in dev | 每轮按 test-agent → dev-agent → analyst-agent 的安全优先级推进一个 Story 步骤；dev-agent 在 Story 完成时 commit，每次代码变动后重启并健康检查后端 |
| in review | review-agent；不 commit，持有代码槽，必须通过 `06_review.md` + `block-release` 的人工批准门禁 |
| cancelled | 终态，不委派；由人工执行 task-cancel |

test/dev 不直接对话：test-agent 独占写 `41_test_results.md` 并用 `Finding ID` 提出可疑失败，dev-agent 独占写 `42_dev_response.md` 做 `accepted/disputed_test/environment_issue/requirement_ambiguity` 响应。同一 Finding 被反驳后重测仍失败时进入 analysis 或人工裁决，不允许无限往返。

dev-agent 创建的所有 Story/回流修复 commit 统一使用：

```text
[s-di.lan] #<需求卡号> <feat|fix|refactor|chore|docs|test|style>: <中文简述>
```

## 7. 上线后不要做的事

- 不要把 `scripts/loop/`、`.cursor/commands/loop.md` 或 schema 当作临时实验文件删除；它们是正式 loop 基础设施。
- 不要把 subagent 复制到项目 `.cursor/agents/`。
- 不要把任务主数据维护在 Markdown 表格里。
- 不要让 `/loop` 跳过 `loopctl` 直接手写 SQLite 二进制文件。
- 不要让 subagent 绕过 Agile 状态路由。
- 不要自动关闭卡片、Bug、PR 或合并代码。
