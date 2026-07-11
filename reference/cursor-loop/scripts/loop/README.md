# loopctl

`loopctl` 是 Cursor `/loop` 的正式 SQLite 命令行工具，项目根目录固定入口为 `scripts/loop/loopctl.py`。agent 和 `/loop` 不应搜索或回退到其他副本。

第一版只维护一张任务主表：

- `tasks`

问题文件由 CLI 直接追加写入 Markdown，不进入 SQLite。`question-add` 会根据任务当前 `current_subagent` 自动选择默认文件：`analyst-agent` 写 `90_analysis_questions.md`，`test-agent` 写 `91_test_questions.md`，其他 agent 写通用 `90_questions.md`。显式传 `--questions-file` 时以显式路径为准。

## 初始化

```bash
python scripts/loop/loopctl.py init
```

默认读取：

```text
.project/_loop/schema.sql
```

默认创建：

```text
.project/_loop/loop.db
```

## 常用命令

查看任务状态统计：

```bash
python scripts/loop/loopctl.py status
```

添加人工任务：

```bash
python scripts/loop/loopctl.py task-add \
  --actor human \
  --title "项目列表支持按 PIC 筛选" \
  --link "https://example/card/123" \
  --item-type requirement \
  --priority P1 \
  --status backlog \
  --next-step "收集上下文并定位任务类型"
```

读取当前任务中心已处理过的 URL：

```bash
python scripts/loop/loopctl.py task-url-list
```

当 `pipeline-all` 发现 `inbox.md` 的 MD5 变化时，会返回 `source-agent` 委派。`source-agent` 收到委派后应先读取这个列表。新发现的 URL 如果已经存在，就跳过；不存在时再调用 `task-ingest`。

生成本轮所有委派计划：

```bash
RUN_TOKEN=$(python scripts/loop/loopctl.py run-begin --lease-minutes 120)
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN"
```

租约用于防止两个定时 `/loop` 重叠委派同一任务。所有 subagent 返回后必须释放：

```bash
python scripts/loop/loopctl.py run-end "$RUN_TOKEN"
```

查看租约：

```bash
python scripts/loop/loopctl.py run-status
```

如果上一轮异常退出，默认最多锁定 120 分钟。只有确认旧 subagent 已全部停止时才可强制解锁：

```bash
python scripts/loop/loopctl.py run-end --force
```

默认输出 JSONL，每行一个委派 envelope：

```jsonl
{"task_id":"","title":"Inbox changed","item_type":"source","priority":"","link":"","external_id":"","external_status":"","agile_status":"","pipeline":"source","agent":"source-agent","resource":"none","current_subagent":"","resume_pending":0,"analysis_approved_index":0,"review_approved":0,"approval_file":"","last_actor":"loopctl","work_dir":".project/_loop","story_index":null,"analysis_index":0,"dev_index":0,"test_index":0,"total_stories":0,"next_step":"process changed inbox.md","blocked_reason":"","owner":"","evidence":"inbox.md md5 changed","risk":"new tasks will be routed on the next loop run after source-agent commits inbox md5","description":"process changed inbox.md"}
{"task_id":"TASK-xxxx","title":"项目列表支持按 PIC 筛选","item_type":"feature","priority":"P1","link":"https://example/card/123","external_id":"CARD-123","external_status":"进行中","agile_status":"in dev","pipeline":"analysis","agent":"analyst-agent","resource":"none","current_subagent":"analyst-agent","resume_pending":0,"analysis_approved_index":0,"review_approved":0,"approval_file":"","last_actor":"dev-agent","work_dir":".project/features/20260708-项目列表按pic筛选","story_index":1,"analysis_index":0,"dev_index":0,"test_index":0,"total_stories":3,"next_step":"story-1 requirements + plan","blocked_reason":"","owner":"","evidence":"","risk":"","description":"story-1 requirements + plan"}
```

`task_id` 是给 subagent 执行 `loopctl` 命令用的内部字段；`title` 是给 `/loop` 汇总展示用的人类可读字段；`work_dir` 是当前任务唯一工作目录。`/loop` 汇报时默认展示 title，不展示 task id。

`resource=browser` 表示该委派会占用 Chrome MCP。`pipeline-all` 默认每轮最多返回一个 browser 委派，避免多个 backlog/repro/test agent 抢同一个浏览器。未释放的 `blocked` 任务不会进入委派结果，只会出现在 `block-list` 报告里。

如需临时调试旧文本格式，可以使用：

```bash
python scripts/loop/loopctl.py pipeline-all --run-token "$RUN_TOKEN" --format pipe
```

幂等写入外部监控发现的任务，URL 作为幂等键。CLI 仍作为兜底幂等保护：

```bash
python scripts/loop/loopctl.py task-ingest \
  --actor source-agent \
  --title "项目列表支持按 PIC 筛选" \
  --link "https://example/card/123" \
  --item-type requirement \
  --priority P1 \
  --external-status "进行中"
```

如果 URL 不存在，会插入任务并返回：

```text
200 OK created TASK-xxxx
```

如果 URL 已存在，通常应由 `source-agent` 提前跳过；如果仍调用到 CLI，会直接返回成功，不做任何变更：

```text
200 OK exists TASK-xxxx
```

列出未完成任务：

```bash
python scripts/loop/loopctl.py task-list
```

更新任务状态：

```bash
python scripts/loop/loopctl.py task-update TASK-xxxx \
  --actor story-splitter-agent \
  --status "ready for dev" \
  --current-subagent analyst-agent \
  --total-stories 3 \
  --next-step "story 拆分完成，等待逐个 story 分析与开发"
```

由于当前没有 worktree，CLI 会阻止第二个任务进入代码工作槽。代码槽包括 `in dev`、`in review`、`blocked + resume_status in (in dev, in review)` 和 `blocked + current_subagent=review-agent`。dev-agent 每完成一个 Story 创建本地 commit；review-agent 不 commit，但在审查、人工批准和驳回期间持续占槽，避免代码交叉。

`ready for dev` 是开发等待队列，但 analyst 不占代码槽。`story-splitter-agent` 拆卡完成后进入 `ready for dev`；`pipeline-all` 会把未分析的 story 交给 `analyst-agent`。当某个 ready 任务已经存在 `analysis_index > dev_index` 且代码槽空闲时，CLI 会在所有可开发的 ready 任务中随机返回一个 `dev-agent` 委派，由 `dev-agent` 先更新为 `in dev` 再开始改代码。

`current_subagent` 用于记录当前阻塞或确认责任归属。任务进入 `blocked` 后，`loopctl` 会生成 `block.md` 并记录 `resume_status`。未释放前不会回派 agent；用户执行 `block-release <TASK_ID>` 后，CLI 会自动恢复原状态、清空 `blocked_reason` 并设置一次性 `resume_pending`。下一轮只回派原 `current_subagent` 消费人工答复；该 agent 第一次更新任务后，正常管线才恢复。

`task-add`、`task-ingest`、`task-context-init`、`task-update` 和 `task-rewind` 都要求 `--actor`。CLI 会校验角色可修改字段、可进入状态、可交接的 `current_subagent` 和可执行的回退，并将成功操作写入 `last_actor`。这是防误操作的角色门禁，不是密码学身份认证。

analyst-agent 和 review-agent 还有独立人工门禁：进入 blocked 时必须提供 `--approval-file`，且文件决策必须是 `pending`。`block-release` 会读取用户修改后的决策：

- `90_analysis_questions.md`：`Analysis Decision: continue` 只允许下一轮澄清；`confirmed` 才会推进 `analysis_approved_index`。
- `06_review.md`：`Review Decision: changes_requested` 要求 review-agent 回退；`approved` 才会设置 `review_approved=1`。

`task-update` 会拒绝未审批的 `analysis_index` 前进，也会拒绝未人工审阅的 `done`。进入 `done` 时还必须显式传入已存在的 `.project/archive/{features,bugs,tech}/<name>` 和其中的 `06_review.md`，避免未归档就完成。

CLI 强制游标满足：

```text
0 <= test_index <= dev_index <= analysis_index <= total_stories
```

`task-update` 只允许游标向前推进，且每次最多推进一个 story。测试失败、需求变化、plan 失效、评审驳回或重新拆卡必须使用统一逆向命令：

```bash
# 回到某个 story 的业务分析
python scripts/loop/loopctl.py task-rewind TASK-xxxx \
  --actor review-agent \
  --to analysis --story 2 --reason "AC 需要调整"

# 回到某个 story 的开发或测试
python scripts/loop/loopctl.py task-rewind TASK-xxxx \
  --actor test-agent \
  --to dev --story 2 --reason "测试失败"

python scripts/loop/loopctl.py task-rewind TASK-xxxx \
  --actor review-agent \
  --to test --story 2 --reason "测试证据需要补齐"

# 重新拆分全部 story
python scripts/loop/loopctl.py task-rewind TASK-xxxx \
  --actor review-agent \
  --to plan --reason "story 边界需要重拆"
```

如果任务已经产生代码或 Story commit，回退后会保持 `in dev` 并继续占用代码槽；analyst 或 story-splitter 不会因此释放其他任务进入同一工作区。

重复任务、误入库或需求撤销使用终止命令，不要永久 blocked：

```bash
python scripts/loop/loopctl.py task-cancel TASK-xxxx \
  --reason "与 TASK-yyyy 重复"
```

如果任务处于 dev/review 或从这些状态 blocked，CLI 会拒绝取消。人工确认当前任务的工作区、Story commits 和回退策略已经清理或妥善保留后，再显式增加 `--confirm-code-clean`。`cancelled` 是终态，不再进入 `pipeline-all`；现有工作目录保留作审计。

查看当前未解除阻塞：

```bash
python scripts/loop/loopctl.py block-list
```

阻塞解决后释放：

```bash
python scripts/loop/loopctl.py block-release TASK-xxxx
```

创建本地工作目录：

```bash
python scripts/loop/loopctl.py task-context-init TASK-xxxx \
  --actor backlog-agent \
  --kind feature \
  --slug "项目列表按pic筛选" \
  --status "in plan" \
  --next-step "基于 01_init_input.md 生成或更新 02_requirements.md"
```

目录名会生成为：

```text
.project/features/YYYYMMDD-项目列表按pic筛选/
```

目录名必须是可读业务名。中文标题会被保留；如果标题无法生成业务名，CLI 会要求显式传入 `--slug`，不会自动退化为 `task-<hash>`。

记录 blocked 需要人工确认的问题。必须提供 `--work-dir`，CLI 会根据当前任务的 `current_subagent` 自动选择问题文件：

```bash
python scripts/loop/loopctl.py question-add \
  --task-id TASK-xxxx \
  --title "无法访问原始任务链接" \
  --work-dir ".project/intake/20260707-项目列表按pic筛选" \
  --blocked-reason "URL 无权限访问" \
  --question "请提供可访问的任务链接或粘贴原始内容" \
  --why "backlog-agent 需要原始描述、评论、页面内嵌图片原图和附件才能继续" \
  --recommendation "提供可访问链接，或把标题、正文、评论、原图文件和附件索引补充到 01_init_input.md"
```

## Test / Dev 异步交接

SQLite 只负责路由和游标，不存储 agent 对话。test-agent 在 `<story-dir>/41_test_results.md` 中用稳定 `Finding ID` 记录原始失败主张，dev-agent 在 `<story-dir>/42_dev_response.md` 中使用同一 ID 回复。

- `accepted`：修复并重测。
- `disputed_test`：无代码变更的反证，交回 test-agent 独立重测。
- `environment_issue`：恢复运行时/环境后重测。
- `requirement_ambiguity`：使用 `task-rewind --to analysis`。

同一 Finding 在 `disputed_test` 后仍失败则不再直接往返：AC 歧义进 analysis，客观证据冲突进 blocked 人工裁决。

dev-agent commit 格式为：

```text
[s-di.lan] #<需求卡号> <feat|fix|refactor|chore|docs|test|style>: <中文简述>
```

## 主数据边界

SQLite 是主数据：

- `tasks`

Markdown 负责人类可编辑控制台：

- `control.md`
- `inbox.md`
- `<work-dir>/00_loop_state.md`：由 `loopctl` 自动维护，agent 不手写
- `<work-dir>/90_questions.md`：放工作目录级的通用 human-in-the-loop 问题
- `<story-dir>/90_analysis_questions.md`：放 analyst-agent 的业务分析决策确认
- `<story-dir>/91_test_questions.md`：放 test-agent 的账号、环境、测试数据、权限、入口 URL、复现路径或期望证据补充
- `<story-dir>/40_test_plan.md`：test-agent 基于 `requirements.md` 生成和审查的黑盒测试计划
- `<story-dir>/41_test_results.md`：test-agent 逐条执行测试后的结果和证据
- `<story-dir>/42_dev_response.md`：dev-agent 对 Test Finding 的根因判断、反证、修复/环境处理和重测前提
