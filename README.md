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
```

SQLite 数据库位于 `.project/_loop/loop-ui.db`。工作目录中的 Markdown 和附件继续保存在 `.project/` 下。

## 目录

```text
app/                 Next.js 页面与 Server Actions
src/application/     Task、Question、blocked 等用例
src/infrastructure/  SQLite 与 migration runner
migrations/          顺序 SQL migrations（Umzug 管理）
.project/            本地数据库与工作文件
```
