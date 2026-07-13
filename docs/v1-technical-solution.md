# Loop Engineering UI：V1 技术方案

## 1. 目标与边界

V1 的目标是把现有 Cursor Loop 的任务、Story、人工确认、运行日志和工作文档产品化为本地 UI。第一版不扩展流程能力，不引入远端服务；重点是把现有 loop 流程线上化、结构化、可观察。

V1 必须保留：

- 当前状态机、角色权限、游标约束、代码槽、browser 限制、本地单 Runner、`blocked` / `block-release` / `task-rewind` 语义。
- SQLite 作为本地持久化方案。
- 可插拔 Agent Executor 作为执行入口，V1 支持 Cursor、Codex 与 Claude CLI。
- 本地 workspace 仍是代码修改发生的位置。

V1 明确不做：

- 云端部署、多用户实时协作、远程文件存储。
- Redis、独立 Worker、队列平台或新的异步任务系统。
- 修改已有 Task / Story / Agent / Pipeline 术语。
- 兼容旧 `.project` 数据。

## 2. 总体架构

```mermaid
flowchart LR
  User["用户"] --> Web["Next.js UI\nReact + TypeScript"]
  Web --> App["Server Action / Route Handler\n应用层与权限校验"]
  App --> Domain["领域层\nTask / Story / Question / Document / Approval"]
  App --> DB[("SQLite\napp data / repo hash / loop-ui.db")]
  Runner["逐个执行 Runner"] --> App
  Runner --> Executor["Agent Executor Port"]
  Executor --> Agent["Cursor / Codex / Claude CLI\n每次只处理一个 delegation"]
  Agent --> Result["Structured Agent Result"]
  Result --> App
  Agent --> Repo["Workspace Repo\n只做代码读写"]
```

系统是本地模块化单体：Next.js 页面、Server Action、领域用例、SQLite 连接和 Agent runner 都在同一应用仓库中。业务事实只落 SQLite；目标 repo 只作为代码工作区，不再生成 `.project` 工作文件。

## 3. 技术选型

| 层次 | V1 选择 | 说明 |
|---|---|---|
| 应用框架 | Next.js + React + TypeScript | 单进程承载页面、Server Action、领域用例和本地数据访问。 |
| UI 组件 | lucide 图标 + 自定义 CSS | 直接实现产品界面，不依赖 prototype 代码。 |
| 服务端入口 | Next.js Server Action / Route Handler + Zod | 表单和命令统一进入 application command。 |
| 领域代码 | 纯 TypeScript | 不依赖 React、Next 或 SQLite driver。 |
| 数据库 | SQLite | 应用级 `data/loopwork.db` 保存当前工作区；每个 workspace root 使用独立业务数据库：`data/<repo-root-short-hash>/loop-ui.db`。 |
| SQLite 访问 | `better-sqlite3` | 本地同步事务模型简单可控。 |
| 数据库迁移 | Umzug / 顺序 SQL migration | 应用级和项目级数据库都通过 `schema_migrations` 记录已执行 migration，提供类 Flyway 的顺序变更。 |
| Agent 执行 | Agent Executor Port + Cursor/Codex/Claude Adapter | App 启动逐个执行 runner；runner 对每个 delegation 单独启动一次所选 CLI，并把不同 JSON 流标准化为用户友好日志。 |
| 执行器设置 | SQLite `project_settings` | 每个 workspace 独立选择执行器，默认 Cursor；Codex 可从 GPT-5.6 Sol/Terra/Luna 三档模型中选择并设置 reasoning effort，CLI 认证仍使用各工具本机账号。 |
| Agent 上下文与结果 | Runner 注入 + JSON Schema | Runner 注入完整 Task 上下文；Agent 只返回结构化结果，Application 负责持久化和状态推进。 |

代码仓库结构：

```text
app/                    # Next 页面与 Server Actions
src/domain/             # 状态机、权限和领域规则
src/application/        # 用例、查询、命令、运行日志
src/infrastructure/     # SQLite、migration、Agent Executor Adapter 与 runner
migrations/             # 顺序 SQL migrations
app-migrations/         # 应用级配置数据库 migrations
scripts/loop/           # loopctl wrapper、runner 脚本
data/                   # 应用本地运行数据，按 repo 根路径短 hash 分目录
prototype/              # 历史资料与 prototype，不参与运行
```

## 4. 数据边界

### 4.1 事实来源

| 信息 | 事实来源 | 说明 |
|---|---|---|
| Task 生命周期、游标、当前 agent、Run 状态 | SQLite `tasks` / `loop_meta` | 所有状态改变必须走 application command。 |
| Story 列表 | SQLite `stories` | Application 根据 story-splitter 结构化结果创建，UI 直接展示。 |
| 分析、复现、测试、review、上下文文档 | SQLite `documents` | Application 根据 Agent Result 写入，UI 可直接查看正文。 |
| Questions 与用户答复 | SQLite `questions` | Application 根据 Agent Result 创建；用户在 UI 回答。 |
| Approval | SQLite `approvals` | analysis 问题解决状态与 review 人工门禁记录。 |
| 运行日志 | SQLite `run_logs` | runner 逐行写入，运行面板通过 SSE 按 `log_id` 增量读取。 |
| 代码变更 | Workspace repo | dev-agent 仍在用户选择的 repo 中修改代码。 |
| 当前 workspace root | SQLite `data/loopwork.db` | 应用级配置；设置页切换后立即选择对应项目数据库。 |

### 4.2 Agent 执行边界

App/runner 是唯一调度者。Runner 每次只取得一个 delegation，启动所选 CLI，应用结构化结果后重新读取数据库计算下一步：

```text
dispatch one -> executor.run -> parse Agent Result -> application command -> dispatch again
```

每次 CLI 只收到当前 delegation 的 `task_id`、`agent`、`pipeline`、`story_index` 和目标描述。Agent 不具备全量派发、创建或停止 Run 的 CLI 命令。

当前 agent 可以在本 delegation 内部使用辅助 subagent 做上下文收集或局部分析，但辅助 subagent 不能处理其他 delegation，不能推进 Task 状态；最终写库和状态更新仍由当前 agent 负责。

Runner 会校验关键 delegation 的完成契约。analyst 必须系统性遍历当前 Story 的设计决策树，并在一次结果中返回所有尚未解决的决策问题及推荐答案；能够从代码库查明的事实不得询问用户。存在问题时 Application 批量创建 Question 并阻塞 Task，全部回答后由 resume delegation 更新分析；没有问题时直接推进 `analysis_index`，流程不自动补建确认问题。

dev-agent 只实现和测试，不暂存、不提交、不推进状态。Runner 在启动前检查工作区干净，完成后自动创建包含 Task/Story 标识的 Git commit；Application 校验提交后保存 dev note 并推进 `dev_index`。无法安全隔离时由流程创建阻塞问题。

### 4.3 写入规则

1. UI 和 runner 不能直接改 SQLite；必须通过 application command。Agent 完全不写数据库。
2. Agent 不再写 `.project`、`90_questions.md`、`06_review.md` 或工作文档 Markdown。
3. Runner 在 Prompt 中注入 Task、Story、Question、Document、Approval 和事件上下文。
4. Agent 最终只返回符合统一 Schema 的 JSON；Application 保存 artifact、stories、questions 和 agent_results。
5. 状态、游标、阻塞、恢复、review 人工门禁和 Git 提交都由流程控制。
6. Runner 和 Agent 的运行日志写入 `run_logs` 表；运行面板不读取 run log 文件。
   Agent 不调用日志命令；Runner 直接解析 CLI stream，Application 自动记录领域事件。
7. 当前 workspace root 存在应用级 SQLite；业务数据库按 workspace root 短 hash 隔离。短 hash、数据库路径和 app data 目录对普通用户不可见。

## 5. 维护命令边界

`loopctl` 仅用于人工维护和诊断，不注入 Agent Prompt。正常 Pipeline 不依赖 Agent 调用任何命令。

核心命令：

```text
task-context
story-add
document-upsert
document-list
document-get
question-add
task-update
task-rewind
block-release
run-status
```

示例：

```bash
python scripts/loop/loopctl.py task-context --task-id TASK-id

python scripts/loop/loopctl.py document-upsert --json '{
  "taskId": "TASK-id",
  "actor": "analyst-agent",
  "kind": "analysis",
  "storyIndex": 1,
  "title": "Story-1 Analysis",
  "format": "markdown",
  "content": "分析正文"
}'

python scripts/loop/loopctl.py question-add --json '{
  "taskId": "TASK-id",
  "actor": "analyst-agent",
  "kind": "analysis",
  "storyIndex": 1,
  "blockedReason": "等待用户确认业务规则",
  "blockTask": true,
  "questions": [
    {
      "title": "问题标题",
      "question": "需要用户回答的具体问题",
      "why": "为什么必须确认",
      "recommendation": "建议答案，可为空"
    }
  ]
}'
```

## 6. 页面与能力映射

| 页面 | 展示内容 | 可执行操作 |
|---|---|---|
| 工作台 | blocked、近期事件、运行状态 | 打开 Task、进入运行面板。 |
| Task 列表 | 状态、优先级、进度、当前 agent | 创建 Task、打开详情。 |
| Task 详情 | Task 概览、Story、Questions、Documents、Approvals、事件 | 新增 Story、回答问题、解除阻塞、状态流转、rewind、cancel。 |
| 运行面板 | 当前本地 Run、Agent 结构化日志 | 开始运行、结束运行、观察 pipeline 进展。 |
| 项目设置 | 当前 workspace root、Agent 执行器 | 输入并切换工作区根目录；选择 Cursor、Codex 或 Claude。存在活跃 loop 时拒绝切换。 |

## 7. 迁移与实施顺序

1. 使用 `data/loopwork.db` 保存当前 workspace root，使用 `data/<repo-root-short-hash>/loop-ui.db` 作为每个 workspace 的独立业务数据库。
2. 使用 SQL migration 管理表结构。
3. 保留旧 schema 中必要兼容列为空值，但新逻辑不再读写旧工作文件。
4. 将 Questions 线上化到 `questions` 表。
5. 将业务文档线上化到 `documents` 表，并扩展 agent 命令替代读写文件。
6. 将运行日志线上化到 `run_logs` 表。
7. 通过 Agent Executor Port 隔离 CLI 差异，使每次 CLI 只执行单个 delegation；内部辅助 subagent 只作为当前 agent 的上下文工具，不参与 pipeline 调度。

## 8. V1 验收标准

- 切换 workspace root 后，使用独立 `data/<repo-hash>/loop-ui.db`。
- 新建 Task 后可以进入持续 loop，并由外部 runner 逐个执行 pipeline agent。
- Application 根据 Agent Result 创建的问题写入 `questions` 表，Task 详情页可展示和回答。
- Application 根据 Agent Result 生成的分析、复现、测试、review 文档写入 `documents` 表，Task 详情页可查看正文。
- 运行面板从 `run_logs` 表显示所选执行器的用户友好日志，能观察 agent、tool call、子过程和错误。
- 任一 UI command 都不能绕过 actor 权限、游标、审批和代码槽约束。
