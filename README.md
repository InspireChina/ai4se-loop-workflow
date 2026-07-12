# Loop Engineering UI

本地运行的模块化单体：Next.js 页面、领域用例、SQLite、版本化 SQL migrations 和可插拔 Agent 执行器运行在同一应用仓库中。目标 repo 只保存产品代码，Loop 业务事实全部进入 SQLite。

## 启动

```bash
npm install
npm run db:migrate
npm run dev
```

打开 `http://localhost:3000`。若该端口被占用，Next.js 会显示实际可用端口。

## 常用命令

```bash
npm run db:migrate  # 执行 migrations/*.sql
npm run build       # 类型与生产构建校验
npm run loopctl -- status
```

当前工作区根目录由项目设置页维护在应用级 `data/loopwork.db`，切换后立即生效。每个项目的业务数据库位于 `data/<repo-root-short-hash>/loop-ui.db`，目标 repo 不再生成 `.project` 工作目录。

查看当前 repo 对应的数据目录：

```bash
python scripts/loop/loopctl.py paths
```

## 跑一轮 Loop

UI 运行面板可以点击“开始运行”，创建 run lease 并逐条执行本轮 delegation。项目设置中可以选择 Cursor、Codex 或 Claude，默认使用 Cursor：

```bash
cursor agent --print --output-format stream-json --force --workspace <workspace-root>
codex exec --json -C <workspace-root> <prompt>
claude --print --output-format stream-json <prompt>
```

执行器的 stdout、stderr 和 tool 事件会被标准化后写入 SQLite `run_logs`，并通过 SSE 在 `/runs` 页面实时展示。

Run Lease 与 Pipeline 派发只由 Web App 和内部 Runner 管理，不提供等价的 Agent CLI 命令。外部 runner 按 delegation 的 `agent` 字段逐条启动所选 CLI，直接解析 stream-json / JSONL、工具事件、stderr 和退出码并写入运行日志。单个 agent 可以使用辅助 subagent 收集当前 delegation 的上下文，但不能调度其他 pipeline agent。

## V1 已实现范围

- Task 创建、列表、详情和状态流转。
- 数据库优先的 Task 上下文，不生成旧 `.project` 工作文档。
- Story 新增与进度游标展示。
- Question、Approval 和业务 Document 全部写入 SQLite。
- blocked / block-release，保留 resume status 和 resume pending 规则。
- rewind、cancel 和单代码槽保护。
- pipeline 计算，包含浏览器资源限制和代码槽限制。
- Cursor、Codex、Claude 可插拔执行器、`scripts/loop/loopctl.py` Agent 命令入口、run lease 和数据库流式运行日志。
- 多 repo 数据隔离：按 repo 根目录短 hash 选择 `data/<hash>/loop-ui.db`。
- Umzug 管理的 SQL migration，行为接近 Flyway 的顺序迁移。

## 目录

```text
app/                 Next.js 页面与 Server Actions
src/application/     Task、Question、blocked 等用例
src/infrastructure/  SQLite、Agent Executor Adapter 与 runner 进程管理
migrations/          顺序 SQL migrations（Umzug 管理）
app-migrations/      应用级设置数据库 migrations
scripts/             migration 与 loopctl 命令
data/                应用本地运行数据（按 repo 根路径短 hash 分目录，gitignore）
reference/           旧 cursor-loop 和原型材料
```
