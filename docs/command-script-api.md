# 命令脚本接口 v1

Dev 的 `development.code-review.changedFiles` 是必填的本轮文件声明，使用仓库相对路径数组；无代码变更时明确填写 `[]`。脚本将其传给终止结果，驱动在有变更声明时读取实际 Git HEAD 建立提交关联。文件声明本身不等于提交或独立验收证据，不能省略后再推断为走查无改动。

Workflow 固定角色、Pipeline、执行授权、并发和资源锁，按接口调用当前工作目录的 `.omp/commands/<agent-id>.cjs`。这些文件是 Node.js 原始源码，直接加载，无须编译或导入数据库。额外文件不会增加 Workflow 角色。缺失文件、接口版本不支持、角色不匹配和必要入口缺失均报错，不回退到内部实现。

## 文件与实现

```text
.omp/commands/dev-agent.cjs                       # 开发阶段、实际 validate 和 result 函数
.omp/commands/test-agent.cjs                      # 独立验证阶段、实际校验和结果组装
.omp/commands/feedback-agent.cjs                  # 分流与验证两条链及其算法
.omp/commands/direct-agent.cjs                    # Direct RUN → SUBMIT 调用入口
.omp/commands/workflow/definitions.cjs            # 原始阶段生成和结构校验函数
.omp/commands/workflow/command-chain-runtime.cjs  # 原始命令处理、状态读写、证据与恢复函数
.omp/commands/workflow/direct-runtime.cjs         # 原始 Direct 命令实现
```

各 Agent 文件中的 `validate` 和 `result` 是可执行函数。修改条件、错误判断、证据使用和组装结果时，直接修改这些函数；公共的 Artifact、Decision、阶段推进等实现可以在共享 runtime 中修改。`describe` 可以通过 `host.define(id, input)` 复用原有阶段构造，也可用 JavaScript 计算和调整返回的完整阶段对象。阶段字段、命令、校验器和默认算法都能在这些源文件中定位。

共享文件是实际运行源码，不是生成产物。`npm run build` 不会重写它们。引擎按源码哈希检测更改，同时刷新工作目录模块缓存，入口与共享逻辑会在下一次加载或命令调用时生效。原有任务草稿继续保留；调整阶段结构应在执行空闲时进行。

## 原生 Command 与命令链如何配对

OMP 原生项目命令位于 `.omp/commands/*.md`，通过 `/<文件名>` 启动；全局默认目录为 `~/.omp/agent/commands/`。LoopWork 只绑定当前工作目录的同名文件，不使用全局替代。参见 [OMP 原生命令文档](https://github.com/can1357/oh-my-pi/blob/main/docs/slash-command-internals.md)。

以开发角色为例：`/dev-agent` 原生展开 `.omp/commands/dev-agent.md`，Workflow 通过 API v1 调用同目录 `dev-agent.cjs`。Markdown 说明专业职责、配套脚本及首个工具调用；每次派发还注入 Workflow Command Binding，明确本轮角色、Pipeline、链 ID、绝对文件路径和入口。Feedback 的两条链由本轮 Pipeline 区分，不依赖模型猜测。

主流程 Markdown 不使用 `$ARGUMENTS`、`$1`、`$@` 或 Handlebars 参数占位符。完整工作包作为一个引用参数传入，由 OMP 在命令模板渲染后追加，保留 JSON 引号、空格、换行和模板原文。启动前核对原生命令注册和源文件哈希；会话目录保留审计快照。真正的 OMP 子 Agent 定义继续放在 `.omp/agents/`，LoopWork 不读取它们作为流程 Prompt。

任务 Chat、配置辅助、验证协助和 Evaluator 的四个 Markdown 模板也在 commands 目录；辅助会话继续按原逻辑替换任务字段、冻结正文后附加到会话，不冒充固定流程角色，也不继承父执行的 slash command。

## 给维护同事

每个角色脚本顶部说明配套 Command 和修改入口，函数注释解释参数、返回值、状态操作及验证边界。修改业务判断看 `validate`，交付内容看 `result`，步骤与字段看 `describe`；公共的阶段导航、回执、恢复和数据操作在 workflow 目录。修改角色职责或步骤时同步检查同名 Markdown，具体阶段和命令始终以 `status` 返回的工作包为准。

## 必要调度约定

类型定义见 [command-chain-script.ts](../src/domain/command-chain-script.ts) 和 [command-chain-state.ts](../src/domain/command-chain-state.ts)。所有入口都是同步调用，不接受 `async` 或生成器函数。

| 字段或入口 | 返回值与用途 |
| --- | --- |
| `apiVersion: 1` | 接口版本；不支持的版本拒绝加载 |
| `agent` | 必须等于当前固定角色 ID |
| `describe({ define })` | 返回本角色完整命令链数组；链 ID、阶段对象和字段遵守调度契约 |
| `initialize(runtime, db, execution, draft)` | 初始化已授权执行的阶段草稿；默认复用原有输入冻结与初始状态 |
| `execute(runtime, invocation)` | 执行当前领域命令，同步返回协议文本；`invocation` 包含 db、execution、draft、command、positionals、flags |
| `validate(context)` | 返回错误消息字符串数组；空数组表示本角色对应校验通过；context 提供 db、draft、names、artifacts、decisions、tools |
| `result(context)` | 返回原有结构化 AgentResult；仍由引擎的结果 Schema 校验，普通文本不替代结果提交 |
| `restore(runtime, db, source, target)` | 继承有效草稿并恢复执行，默认保留原有重试、证据重置和 Dev/Test 规则 |
| `help(runtime)` | 返回当前协议帮助文本 |
| `project(runtime, db, taskId)` | 可选只读投影；Backlog 保留此入口以提供已提交需求上下文 |

Direct 不创建命令链草稿，因此 `describe()` 返回空数组，提供 `executeDirect(runtime, invocation)` 和 `help(runtime)`，继续使用 `direct run` / `direct submit`。其他流程 Agent 必须提供 initialize / execute / validate / result / restore / help。Feedback 的 `describe` 返回 `feedback-triage` 和 `feedback-verify`，由同一入口按当前 draft 的链 ID 选择结果逻辑。

执行凭证在调用脚本之前由引擎校验；模型调度、任务领取、execution 生命周期、结果应用、代码锁及 Dev/Test 上下文隔离仍归 Workflow。共享 runtime 和角色脚本的默认实现保持原有阶段门禁与恢复行为。脚本是受信任的本地 Node.js 代码，权限等同于修改应用源码，不是隔离沙箱。

## 页面修改

活动 execution 在先调用 `status` 后，可跨阶段只读查询自己的草稿：`artifact get --artifact ID [--block ID] [--key KEY]`、`acceptance get [--key KEY]`、`decision get --tree ID [--key KEY]`。`status` 显示当前必要上下文与记录索引，正文按需完整读取；读取不改变阶段、产物或冻结计划，也不能读取其他 execution 的草稿。写入仍须遵守当前阶段门禁。

Agent 的命令链页面可以选择入口或共享源文件，查看原始代码、使用 Chat 生成草稿、检查语法、保存和下载源码。阶段图由 `describe` 返回的实际定义生成。OMP 模型与思考强度仍在运行参数页独立配置。

语法检查通过 `vm.Script` 只解析代码，不执行页面或模型生成的草稿。保存对已发现文件做路径约束、文件哈希冲突检查和原子替换；不会写入数据库。保存后重新加载并检查调度接口；若接口或阶段无效，页面显示加载错误并阻止对应执行，源文件仍可编辑修复。

运行日志、正文、证据和执行快照继续采用现有文件存储，数据库仍记录任务与执行状态。业务 Prompt 从 `.omp/commands` 读取，专业步骤、规则及 Markdown 模板由 `.omp` Skill 维护。

独立 Test 的计划一旦进入 EXECUTE，即使回退 PLAN 也不能删除或改写已冻结场景。追加场景的 coverageRefs 在写入前校验；已存在的错误引用只能在场景其他字段完全不变时以原 key 修正，原结果保留。

决策关闭的 decision/rationale/evidence 是三个独立短文本，原生工具可直接使用 `--decision`、`--rationale`、`--evidence` 字符串参数。原有 `*-file` 输入仍受执行临时目录约束；不要把一个 `@input` 同时当成三个不同字段的正文。

开发检查的 `check record --receipt` 支持 Harness 捕获的成功 Shell 命令和 OMP 原生 `browser run`。浏览器操作保留自身工具身份，不伪装成 Shell；导航、只读工具、Workflow 提交和失败调用不能作为成功检查。每项检查必须绑定实际执行它的回执，浏览器检查不能借用 `npm test`。工具成功只证明操作执行，是否符合预期仍须由真实断言或观察支持。

脚本字段的数组可声明 `itemType: 'string' | 'number' | 'object'`。默认脚本的验收语义、引用和文件路径逐项要求非空字符串；不符合时在保存前返回精确元素路径。修改数组结构时同步修改 `result()` 的输出映射，保持 AgentResult 接口约定，禁止用 `String(object)` 掩盖类型错误或丢失正文。

原生工具的 `artifact put`、`decision put` 只有一份正文，直接传 `input` 即可自动绑定到执行临时文件；显式 `--content`、`--content-file @input` 继续有效。此便利仅适用于这两种命令，不会将控制命令的普通文本变成产物，也不会替多字段命令猜测正文用途。

结构化记录优先传 JSON 对象，适配器保持字段值原样序列化，继续由脚本 Schema 校验；无需手写 YAML 引号或缩进。Markdown Block 仍传字符串。其他命令的正文只接受文本。

```json
{"args":["artifact","put","--artifact","development","--block","code-review"],"input":{"summary":"审查完成","evidence":"实际证据","changedFiles":[]}}
```

Artifact 的可选 `decision` 是本草稿已有决策的非空字符串 key，无关联时省略整个字段；`none`、`upstream` 等来源或占位说明不自动成为决策。来源依据写入 source。不要与 coverageRefs 等数组字段混用。自动模板仅填写必需字段，可选字段按 Schema 自行补充。
