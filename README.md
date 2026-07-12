# Loop Engineering UI

本地运行的模块化单体：Next.js 页面、领域用例、SQLite、版本化 SQL migrations 和工作目录内的 Markdown 文件运行在同一仓库根目录中。

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

SQLite 数据库位于应用本地 `data/<repo-root-short-hash>/loop-ui.db`。工作目录中的 Markdown 和附件继续保存在目标 repo 的 `.project/` 下。

查看当前 repo 对应的数据目录：

```bash
python scripts/loop/loopctl.py paths
```

## 跑一轮 Loop

UI 工作台可以点击“开始 Loop”，会创建 run lease 并把本轮委派写到 `data/<repo-root-short-hash>/runs/<token>/`。

Cursor 中可以使用项目命令：

```text
/loop
```

命令行等价流程：

```bash
RUN_TOKEN=$(python scripts/loop/loopctl.py run-begin --lease-minutes 120)
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN" --format jsonl
python scripts/loop/loopctl.py run-end "$RUN_TOKEN"
```

`pipeline-all` 输出的每一行都是一个 subagent 委派 envelope。Cursor `/loop` 会按 `agent` 字段把任务交给对应 agent。

## V1 已实现范围

- Task 创建、列表、详情和状态流转。
- 本地上下文初始化，生成 `00_loop_state.md`、`01_init_input.md`、`90_questions.md`。
- Story 新增与进度游标展示。
- Question / Approval 写入 SQLite，同时落到本地 Markdown。
- blocked / block-release，保留 resume status 和 resume pending 规则。
- rewind、cancel 和单代码槽保护。
- pipeline 计算，包含浏览器资源限制和代码槽限制。
- Cursor `/loop` 命令、`scripts/loop/loopctl.py` 兼容入口、run lease、inbox hash 和 dispatch 文件。
- 多 repo 数据隔离：按 repo 根目录短 hash 选择 `data/<hash>/loop-ui.db`。
- Umzug 管理的 SQL migration，行为接近 Flyway 的顺序迁移。

## 目录

```text
app/                 Next.js 页面与 Server Actions
src/application/     Task、Question、blocked 等用例
src/infrastructure/  SQLite 与 migration runner
migrations/          顺序 SQL migrations（Umzug 管理）
scripts/             migration 与 loopctl 命令
.cursor/commands/    Cursor /loop 入口
data/                应用本地运行数据（按 repo 根路径短 hash 分目录，gitignore）
.project/            目标 repo 内的业务工作文件
reference/           旧 cursor-loop 和原型材料
```
