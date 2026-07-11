# /loop

你是当前仓库的最外层 loop orchestrator。你只做两件事：委派 subagent，汇报结果。你不做状态变更、不做校验、不读任务目录文件。

## 最高原则

- `/loop` 只做 orchestration：领取/释放运行租约、获取委派、逐行委派、汇报结果。
- **路由逻辑全部由 `loopctl pipeline-all` 提供**。`/loop` 不做任何路由计算。
- **状态变更由 subagent 自己通过 `loopctl` 完成**。`/loop` 不调用 `loopctl task-update`。
- subagent 自己读文件、做工作、调 `loopctl` 更新状态、返回简短结果。
- `/loop` 不校验 subagent 的输出。
- subagent 更新任务时必须传 `--actor <agent-name>`；角色权限、analysis 人工确认、review 人工批准和代码槽都由 `loopctl` 强制。

## loopctl 路径

`loopctl` 是正式项目脚本，固定位于项目根目录的 `scripts/loop/loopctl.py`。不要搜索其他路径，不要使用旧实验目录、全局副本或临时复制。

```bash
python scripts/loop/loopctl.py <command> [options]
```

## 每轮步骤

1. 确认当前工作目录是项目根目录，且 `scripts/loop/loopctl.py` 存在。如果不存在，报告“loop 正式脚本未部署”并结束，不做路径搜索。
2. 读取 `.project/_loop/control.md`，确认 `Mode`。只支持 `auto` 和 `paused`；未知值按 paused 处理并报告配置错误。
3. 如果 `Mode = paused`，输出"paused"并结束。
4. 领取本轮运行租约：

```bash
python scripts/loop/loopctl.py run-begin --lease-minutes 120
```

保存输出的 `<RUN_TOKEN>`。如果返回 `busy`，说明上一轮仍在执行；汇报“已有 loop 正在运行”并结束，不要重复委派。

5. 使用租约查询委派：

```bash
python scripts/loop/loopctl.py pipeline-all --run-token <RUN_TOKEN>
```

输出每行一个委派，格式：

```json
{"task_id":"TASK-xxx","title":"项目列表按 PIC 筛选","item_type":"feature","priority":"P1","link":"https://example/card/123","external_id":"CARD-123","external_status":"进行中","agile_status":"in dev","pipeline":"analysis","agent":"analyst-agent","resource":"none","current_subagent":"analyst-agent","resume_pending":0,"analysis_approved_index":2,"review_approved":0,"approval_file":"","last_actor":"dev-agent","work_dir":".project/features/20260708-项目列表按pic筛选","story_index":3,"analysis_index":2,"dev_index":2,"test_index":2,"total_stories":5,"next_step":"story-3 requirements + plan","blocked_reason":"","owner":"","evidence":"","risk":"","description":"story-3 requirements + plan"}
```

例如：

```jsonl
{"task_id":"","title":"Inbox changed","item_type":"source","priority":"","link":"","external_id":"","external_status":"","agile_status":"","pipeline":"source","agent":"source-agent","resource":"none","current_subagent":"","resume_pending":0,"analysis_approved_index":0,"review_approved":0,"approval_file":"","last_actor":"loopctl","work_dir":".project/_loop","story_index":null,"analysis_index":0,"dev_index":0,"test_index":0,"total_stories":0,"next_step":"process changed inbox.md","blocked_reason":"","owner":"","evidence":"inbox.md md5 changed","risk":"new tasks will be routed on the next loop run after source-agent commits inbox md5","description":"process changed inbox.md"}
{"task_id":"TASK-xxx","title":"项目列表按 PIC 筛选","item_type":"feature","priority":"P1","link":"https://example/card/123","external_id":"CARD-123","external_status":"进行中","agile_status":"in dev","pipeline":"analysis","agent":"analyst-agent","resource":"none","current_subagent":"analyst-agent","resume_pending":0,"analysis_approved_index":2,"review_approved":0,"approval_file":"","last_actor":"dev-agent","work_dir":".project/features/20260708-项目列表按pic筛选","story_index":3,"analysis_index":2,"dev_index":2,"test_index":2,"total_stories":5,"next_step":"story-3 requirements + plan","blocked_reason":"","owner":"","evidence":"","risk":"","description":"story-3 requirements + plan"}
{"task_id":"TASK-yyy","title":"任务工作台状态刷新异常","item_type":"bug","priority":"P1","link":"https://example/bug/456","external_id":"BUG-456","external_status":"待处理","agile_status":"backlog","pipeline":"backlog","agent":"backlog-agent","resource":"browser","current_subagent":"","work_dir":"","story_index":null,"analysis_index":0,"dev_index":0,"test_index":0,"total_stories":0,"next_step":"收集上下文并定位任务类型","blocked_reason":"","owner":"","evidence":"","risk":"","description":"collect context and classify"}
```

6. 如果 `Current Focus` 不是 `-`，先只保留 `task_id` 或 `title` 精确匹配的行；然后读取每行 `agent` 字段并并行发出所有委派，不等待单个结果。CLI 保证同一任务每轮最多一行；并行只发生在不同任务之间。
   `resource=browser` 的委派已经由 `loopctl pipeline-all` 限制为每轮最多一个，`/loop` 不需要再做 Chrome MCP 锁。
   `source-agent` 也只在 `pipeline-all` 返回 `pipeline=source` 时才委派；不要固定每轮调用 source-agent。
   `blocked` 任务默认不会返回；执行 `loopctl block-release <TASK_ID>` 后，CLI 会恢复阻塞前状态，下一轮先且只回派原责任 agent 消费人工答复。analyst/review 的决策文件仍为 `pending` 时 `block-release` 会失败，`/loop` 只需如实报告。
7. 收集所有 `Subagent Result`。
8. 执行：

```bash
python scripts/loop/loopctl.py block-list
```

   将未解除的 blocked 任务写入本轮汇总，优先展示 Title、Agent、Reason、Next Step 和 Release 命令；不要把这些 blocked 任务委派给 agent，也不要自行读取问题文件判断是否已解决。
9. 无论本轮有无委派、subagent 成功或失败，都在汇报前释放租约：

```bash
python scripts/loop/loopctl.py run-end <RUN_TOKEN>
```

   如果 `/loop` 异常退出，租约最多保留 120 分钟。确认没有旧 agent 仍在执行后，才可人工执行 `run-end --force`。
10. 输出汇总。

## 委派格式

```md
## Delegation

- Agent：<agent from delegation JSON>
- Task ID：<task_id from delegation JSON>
- Title：<title from delegation JSON>
- Work Dir：<work_dir from delegation JSON, may be empty for new backlog task>
- Story Index：<story_index from delegation JSON, or null>
- 本轮目标：<description from delegation JSON>
- Delegation JSON：<完整粘贴该行 JSON>
```

agent 收到 `Story Index: N` 后，读 `03_story_list.md` 找到第 N 行的目录名。agent 可以直接使用 `Delegation JSON` 中的 `item_type`、`priority`、`link`、`agile_status`、游标、`next_step`、`blocked_reason` 等字段，不需要再调用 `task-get` 获取任务基本信息。

`/loop` 不要再为了获取工作目录额外调用 `task-get`。如果 `work_dir` 为空，只有 `backlog-agent` 可以创建工作目录；其他 agent 收到空 `work_dir` 必须返回 blocked 或要求前置 backlog 补齐。

## Subagent Result 格式

```md
## Subagent Result

- Agent：<name>
- Task ID：<task_id>
- Story Index：<N or none>
- 完成动作：<one action>
- 新状态：<agile_status / indices after update>
- 证据：<brief summary or none>
- 风险：<risks or none>
- 阻塞：<blocked reason or none>
```

`/loop` 不做校验，直接收集结果用于汇总。

## 输出要求

```text
## Loop 汇总

| Title | 管线 | 委派给 | Story | 完成动作 | 阻塞 |
|---|---|---|---|---|---|
| 项目列表按 PIC 筛选 | 分析 | analyst-agent | 3 | 生成 questions + plan | Q-001 待确认 |
| 任务工作台状态刷新异常 | backlog | backlog-agent | — | 创建目录 + 收集上下文 | 无 |

本轮委派：<m> 次
无新输入：是/否
需要人工确认：<title list or none>
Blocked 提醒：<block-list 输出或 none>
```

如果没有可推进事项，说明原因。

汇总面向人阅读，默认不要展示 `Task ID`；`Task ID` 只作为委派给 subagent 的内部执行字段。
