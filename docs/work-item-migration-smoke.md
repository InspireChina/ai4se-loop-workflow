# 原生工作流隔离走查

状态：进行中，不能作为完整迁移或完整交付通过证明。

## 现场

- 日期：2026-09-15。
- 独立应用 worktree：`/tmp/loopwork-native-smoke.xXVZsw/app`。
- 独立目标 worktree：`/tmp/loopwork-native-smoke.xXVZsw/library`，起点 `d869849b5ebaa744eac6fa2444c4522dc2e62d99`。
- 独立数据目录：`/tmp/loopwork-native-smoke.xXVZsw/data`。
- UI：`http://localhost:3007`。
- 在设置页添加样例项目；在 UI 将流程与系统辅助 Runtime 配置为 Claude，默认模型。
- 仅此实例设置 `LOOP_WORKFLOW_ENGINE=native`；普通创建入口的全量切换尚未实施。
- 原始 library 工作区有既有修改，未用它作为执行目录。

## 原始场景

经 UI 创建 Develop（Feature）需求 `REQ-4b0c0f5a-a5b1-448b-b24e-e663ab42fdc9`：ISBN-13 支持，保持 ISBN-10 兼容，trim 空白，拒绝非法字符/长度，补充自动化测试，不部署、不推送。

经 UI 启动 Loop。不直接改数据库制造已执行状态，不替 Agent 执行内部命令。

## 初始失败与原场景重跑

1. 外部 node_modules 符号链接被 Turbopack 开发服务器拒绝。保持同一代码及场景，使用 Webpack 开发模式。
2. 隔离进程误用 Node 26（ABI 147），而现有 SQLite 扩展为 Node 24（ABI 137）。显式指定现有 Node 24 可执行文件与 PATH；不重编译主工作区依赖。
3. UI 启动时报 `Cannot read properties of undefined (reading 'resolve')`。`loop_runs` 保存 crashed，无 Execution。Webpack 对动态 `createRequire` 的静态变换导致启动器失效。改为在运行时读取 Node 工厂，重启实例以清除旧生命周期宿主绑定。
4. 同一原始需求重跑：run `32380e4e-24ec-417b-8704-2385e8fd55e2` 注册 Runner pid 42138；Execution `fcdb9aca-872f-48c7-a9a5-4ff8ed0ae525` 为真实 `backlog-agent`，运行中的 `delivery:context@1`。页面显示实际读取源码、工具调用与命令执行日志。

5. 首执行真实提交两项澄清并成为 applied，Context 工作项 waiting；Runner 保持运行，事件驱动休眠，不把等输入当崩溃。通过决策页面回答：所有 ISBN 输入拒绝竖线；保留 ISBN-10 合法的大写 X 校验位（新增 ISBN-13 仅纯数字）。
6. 原始失败：第二个回答保存后，两个输入介入 resolved，但 Context 仍 waiting；旧显示投影变成 system_blocked，整批提交按钮消失。修复 answered 输入的待提交投影，以及原生详情读取/Lane 刷新路径；刷新同一页面，按钮恢复为「提交本批决策并交回需求梳理 Agent」。
7. 经 UI 点击本批提交：保存实际 human resume 事件；Execution `909c4c0f-ddbf-4f1b-9608-f8bc66eaa7fc` 启动 resume，仍绑定 `1a6cb1e4-1780-4205-9e57-49dae899ee32`（Context），work_item_attempt=2、dispatch_epoch=1。原始 Execution 仍 applied，未改写其证据。真实工具输出继续产生。
8. 后续只读核对 OS 中 Runner pid 42138 存活，数据库心跳继续更新；命令链依次推进 decision_resolution → answer_review → to_be → impact_scan。没有仅因观察超时重启执行。页面执行审计从一次增长到两次，工具/命令日志持续产生。发现概览「下一步」残留等待旧答案，修复人工提交时的显示文案并加回归；当前需求已经提交，不重复提交伪造新恢复事件，后续新输入场景还需验证该显示增量。
9. Context 真实完成：第二次执行成为 applied，Context 节点 completed；文档 `b6832791-08e1-42b5-b29a-8918ee4d8dae` 为 Markdown「业务变化上下文」。下游 Plan 节点 `05b13327-eb2d-4c06-a52c-7b61636d4107` running，真实拆分 Execution `22463636-3b94-4982-b556-71ab90421a7e`、Agent story-splitter-agent、Pipeline split、work_item_attempt=1。刷新页面可见「交付拆分」「正在拆分交付单元」及第三次执行审计。仍未宣称 Dev/Test 或完整交付通过。
10. 后续只读数据库核对：同一 Plan 执行 applied、Plan 节点 completed；实际计划建立单元 1 的 Analysis/Dev/Test 依赖节点。Analysis 节点 `c67b4cb3-abba-47f5-a660-f298e8905d34` running，对应真实 analyst-agent/analysis 执行 `ab321bad-ec29-4031-a32d-72dc989c6448`，无 last_error；Dev/Test 及 Review/Closure 仍 pending。没有重启现有 Runner，也没有写入数据库制造完成状态。此证据仅验证启动快照推进到分析，并非本轮角色失败 Intervention 和旧 API 门禁的端到端验证。
11. 继续只读核对：OS 中 Runner pid 42138 仍存活；分析执行在 `2026-09-15 06:18:52 UTC` 留下真实 `phase complete` 成功收据，从 answer_review 推進 delivery_contract，并返回下一阶段工作包。此时该 Execution 仍 running，无 last_error；不能据此宣称 Analysis 已完成或 Dev/Test 已执行。收据表只有 kind/receipt_key/payload_json，phase 与 summary 从真实 payload 读取，未将其他版本数据库的字段假设为当前结构。

12. Analysis 执行随后 applied；Dev 执行 `81e123dc-54f4-4402-9596-15249d759f58` 也 applied。只读 Git 核对真实目标提交 `a36757044892265d40ff678fb2bd5a4fcced0181`，相对起点有 ISBN.java 与 BookTitleAuthorISBNTest.groovy 两个文件的实际修改。读取目标仓库实际测试 XML：Surefire 31 个文件、97 项测试；Failsafe 14 个文件、41 项测试，均零失败、错误或跳过。Test 执行 `4dc79c45-e544-45ac-bf9c-4c7a390b10bf` 此时仍 running，不能将 Dev 的测试报告当成独立 Test 已完成。
13. 发现证据缺口：真实 Git 有上述提交，Dev 执行的 `code_commit` 却为 NULL；Runner 还输出「无需代码变更」。静态逻辑仅依赖结果中 changedFiles 是否存在，通用命令链结果未带此字段。已保留原始现场；需要修复真实代码证据采集并在安全边界更新隔离实例、重跑原场景，不能补写原执行制造正确记录。
14. 主工作区已实现上述修复：异步采集真实 Git 基线/文件差异，并校验来源、代次与代码槽；无变更和不可确认不再混为一谈。真实 Git 临时仓库测试及应用级失效回归通过。继续只读核对既有 Runner pid 42138 在 OS 中存活，run 心跳为 `2026-09-15 06:43:37 UTC`，Test 仍 running、无 last_error。没有因观察超时重启，也没有改写原始 code_commit；此刻尚不能宣称原场景已经验证新证据路径。
15. 用新 Git 采集函数只读核对真实隔离目标，得到 changed、基线 d869849、提交 a367570 及上面两个实际文件路径，和人工 Git 核对一致。没有操作目标仓库或原执行记录。此检查只验证真实数据上的采集器，不证明新 Runner 已完成启动收据→持有代码槽→发布成果的端到端链路；该链路仍需安全更新实例后重跑。
16. Test 执行随后真实 applied，节点 completed；Review 五次执行调用 Cursor CLI 均退出码 1，最终 `1d0fed83-3db4-43db-bf56-7bc30f50d6a1` system_blocked。Runner pid 42138 存活，心跳 `2026-09-15 06:53:47 UTC`。通过 UI 核对设置：流程默认与系统辅助默认仍为 Cursor，前序角色采用各自覆盖，不能把前序 Claude 执行误当全局默认已保存。
17. 正常 UI 将这两个隔离实例默认执行器改为 Claude；刷新设置核对持久值，再回到原需求推进控制点击「解除系统阻塞并继续」。第一次恢复执行 `ff27dc26-3159-41ec-a4d5-f358ecd5fa50` 因 review-agent/resume 没有命令协议，准备阶段失败；来源工作项仍为原 Review、代次 2。主工作区修复了原生派发的恢复协议能力判断，不再给不支持 resume 的角色创造该 Pipeline；对应 Review/拆分回归包含实际凭证签发。
18. 停止前复核：下一次重试 `4c25b6f1-d99f-43d7-8a1b-1eab734a639f` 已自行使用 review Pipeline 真正运行，Review 节点 running、代次 2、resume_pending=0。没有点击停止运行，没有重启 Runner，保留全部错误记录。该旧快照的自行重试不代表本轮修复已端到端验证；后续仍需安全更新后重复原场景。
19. 后续 Review 实际 applied、executor_id=claude；页面进入等待阅读结卡 v1。通过 UI 打开实际报告，核对范围仅 ISBN.java / BookTitleAuthorISBNTest.groovy、实际提交 a367570、独立验证 11 场景、保留大写 X/trim/失败语义、无 schema/lending/外部发布变更，再点击「我已阅读结卡报告并关闭需求」。只读核对 Task done、closure acknowledged、确认时间 `2026-09-15 06:59:31 UTC`；七个主链工作项全部 completed，Closure completion_authority=human，其余为 agent。刷新后在「已完成」列表可见原 ISBN-13 需求。主链启动快照走查已完成；新代码证据和需求级阻塞增量未通过这个旧 Runner 验证。
20. 只读确认该 run 已无 planned/running/output_received/verifying/applying 执行后，才在运行面板正常点击「结束本轮」。随后 run 状态 stopped，最后心跳 `2026-09-15 07:00:38 UTC`；OS 中 pid 42138 已不存在，刷新页面显示「已停止」「开始运行」。没有杀掉正在验证/审查的 Agent，也未因观察超时重启。隔离服务器仍保留，后续可以在这个已验证的安全边界更新代码快照并复跑原始场景。
21. 更新前再次只读核对：上述 run 仍 stopped、旧 Runner pid 不存在、所有任务均无活动主执行，旧目标工作区干净。正常停止仅 Web 开发服务器，使用 apply_patch 将当前相关源码及迁移更新到隔离应用，逐文件核对 94 个文件完全一致。新服务器使用相同 Node 24 / Webpack / 独立数据目录，端口仍为 3007；原任务、原 Git 提交与原失败记录均保留。
22. 在同一 Git 起点 d869849 建立新的、可恢复的目标 worktree `/tmp/loopwork-native-smoke.xXVZsw/library-replay`，未重置已完成目标或原始 library。正常 UI 添加项目 Native Workflow Replay，刷新确认保存的路径与 Claude 默认 Runtime，再从普通 Develop 创建同一 ISBN-13 行为场景 `REQ-a964c794-c07e-492f-a0f5-43cb1330c592`。仅输入沿用先前已确认的大写 X / 竖线策略，业务范围、测试、独立验证与结卡要求不变；不预先写代码或假造执行。
23. 正常运行面板点击「开始运行」：run `a5a61f6d-d420-41e2-9679-c96127bcb7ed` running，Runner pid 89242 与 Claude CLI pid 89259 在 OS 中存活；首执行 `6867f476-bdbe-45cb-b790-59428fe85ed3` 为 backlog-agent/backlog、running、无 last_error，绑定 Context `d5d031d0-8713-49a3-8bcd-87379aa91bee`、独立序号 1。心跳 `2026-09-15 07:15:54 UTC`，真实工具收据持续产生，详情显示一轮执行审计、实际命令及 LIVE COMMAND CHAIN。这只证明新代码已真实启动和派发，尚未证明 Dev Git 成果收据或新代码完整主链通过；继续保留同一轮次观察，不因观察超时重启。
24. Feature 首执行随后 applied，但 Context 状态是 waiting，真实创建一项竖线兼容澄清，不能将 applied 解读为阶段完成。正常决策 UI 选择明确拒绝竖线（保持同一测试需求既定范围），保存后显式点击整批提交；新执行 `55981804-d623-4d50-b50f-dac2cafd2622` 为 backlog-agent/resume、running、无 last_error，仍绑定原 Context 工作项，独立序号 2。原首执行和其 129 条收据保留。

以上证明启动快照的普通 Feature 主链完成：真实澄清等待→逐项回答→明确整批提交→同一节点恢复→Plan→Analysis→Dev→独立 Test→Review→实际报告阅读确认。主链真实完成不等于完整迁移完成：人工仲裁、其他 Pipeline 和多工作组 Feedback 的实际 UI 操作尚未完成。隔离 Runner 是启动时的源码快照，本轮历史执行采纳及失败结算、取消与需求级阻塞控制增量尚未通过这个既有 Runner 验证，后续需要在安全边界更新实例再重测，不把单元测试冒充全量端到端覆盖。

## 当前快照 BA 走查

- 以先前普通 Feature 已产出实际实现和完成主链为先行覆盖，当前 Feature 复跑仍保留正常推进；补充 BA 自然入口，不用 BA 替代 Feature 的代码成果验证。
- 另建同起点的隔离目标 `/tmp/loopwork-native-smoke.xXVZsw/library-ba`。通过 UI 添加 Native BA Smoke 项目，刷新确认保存的独立路径；仅规格，不部署、不推送，不与 Feature 共用可写目录。
- 正常 UI 创建 Business Analysis：`REQ-14735718-7101-41ec-9f62-c5da3f6d4334`，ISBN-13 规格 — 原生 BA 走查。要求完整意图简报、业务方案、规格及独立审查，保持先前已确认的业务规则，代码不实现。
- 同一 run 自动派发真实 `idea-context-agent/ba-intent` 执行 `b9f575a5-e894-4bda-971e-1d1956d6ef6f`；绑定当前工作项 `5e111cc2-bfed-43d4-9be0-2311a92671f4`，独立序号 1，running、无 last_error。注册 CLI pid 92334，Feature CLI 89259 与 Runner 89242 同时运行。
- 页面实际显示 Business Analysis、需求意图确认、LIVE COMMAND CHAIN 和一轮执行审计/一条命令。尚不能据启动状态宣称全部规格产物或阅读确认通过，继续观察同一执行。
- BA 首执行随后 applied、Intent waiting，实际提交五项澄清。正常 UI 逐项保存：两类 ISBN 都 trim；不做内部连字符/空格归一化；登记非法竖线历史值的已知兼容风险但不增加迁移/schema 范围；限定领域 API 与测试观察面、不增加 HTTP 接口；13 位数字限定 ASCII。末项保存后仍显示显式整批提交按钮，点击交回意图 Agent；真实执行 `ea0b8943-ca86-4a64-88e8-97516c8c8632` 为 idea-context-agent/resume、running、无 last_error，仍绑定原 Intent 工作项，独立序号 2。原 139 条首执行收据及五项人工答案保持可追溯。
- 当前隔离副本在正确 Node 24 环境下全量 590 项测试及独立 tsc 均通过。第一次测试误继承目录 shell 的 Node 26，SQLite ABI 137/147 不一致；只纠正测试命令 PATH，不重新编译依赖，不影响正在使用 Node 24 的真实 Runner，也不改写执行数据。
- 隔离 Runner 仍加载此处的 590 项快照；后续主工作区的原生工作项队列和工作项级派发诊断改动（597 项回归）未在这轮运行期间替换。不能把上述 UI 恢复当作该新队列的端到端通过证明。

## 后续核对清单

- 主工作区已进一步移除 legacy 环境运行模式：旧 selector 与历史数据工厂仅在 src/test，生产工厂固定默认 native，生产调度/启动没有旧开关回落。632 项测试/构建/独立 tsc 通过，四个实际 Runtime 入口的 bundle 元数据回归确认不包含 src/test；未热替换 S1。S1 Feature 独立 Test 自动 applied 后，Review `519bdd58-1893-4723-8ea2-5af55fd05c31` 为 review-agent/review、running、无 last_error；BA Spec `bbf8fcf7-7942-4d26-8889-5178d6458804` 已 applied，独立规格审查 `bbbe40c4-67ed-4007-a3a3-40b546711e0e` 为 spec-review-agent/ba-review、running。仍是原 run、当前两条真实 Claude 和 Runner 存活；未宣布最终阅读确认或当前新增代码的完整 UI 升级验证通过。

- S1 真正 Dev 成果证据复验：`37c98b4a-2912-45c8-a06c-3b0ce86b5c77` 已 applied，`code_commit=8f84e27642a9d0edfae27499fe2d92a4052d071b`。实际 library-replay HEAD 与收据完全一致；工作树干净，baseline→HEAD 改 ISBN.java、BookTitleAuthorISBNTest.groovy、AddBookToCatalogueTest.groovy 三个文件，74 行新增/1 行删除。`code_baseline` 为 baseline d869849、clean/readable=true；`code_evidence` 与 `code_commit` 的真实 changedFiles 与 Git 一致，evidence=owned-execution-git-diff，不再丢失本次实际提交。独立 Test `a8fdbccd-3b10-4898-884a-a22dbfe0c6f8` 自动 running、无 last_error；尚未确认测试/Review/结卡终态。OS 实际 Runner 89242 与 Claude 14361/15857 均存活，不能因为观察超时重新启动。
- 主工作区已默认原生：自然创建/定时创建无需 native 环境开关，默认启动须先做历史升级，未采纳 legacy 任务不能混入默认队列。630 项回归/构建/独立 tsc/bundle 检查通过；这些默认切换改动未热替换到仍在执行 Test/BA 的 S1，须在实际排空边界更新副本后重新验证默认入口。

- S1 原 Feature 分析已实际 applied，Dev `37c98b4a-2912-45c8-a06c-3b0ce86b5c77` 正常 running、无 last_error。真实启动收据 `code_baseline / execution-start` 保存 baseline `d869849b5ebaa744eac6fa2444c4522dc2e62d99`、clean=true、readable=true；尚不能宣称最终 code_commit 或独立 Test 通过。
- BA 业务方案首执行 applied 后实际提出首尾 trim 字符范围澄清。普通 UI 决策页选择沿用现有 Java trim（首尾 ≤ U+0020；内部空白拒绝，NBSP/全角空格不扩张），符合原场景保持兼容的边界；末项保存后仍能显式整批提交。UI 状态进入业务方案设计、执行审计增加至四次；实际 `b535fcda-1888-46ab-8a14-5b4fc9f7390b` 为 business-design-agent/resume、running、无 last_error，仍绑定 `69200291-ddea-4bb9-b55c-d8bb70ceb722`、独立序号 2。未改数据库放行或减少原规格要求。主工作区恢复入口增量仍未加载到正在运行的 S1。

- 当前隔离 S1 的实际自然推进已确认：Feature 恢复 Context 后完成 Split，随后 `9438b0f8-7f76-43b6-9e31-74e8a3e69714` 为 analyst-agent/analysis、running；BA 意图恢复完成后 `6c0e83af-c408-4fe4-b1e3-e9a5434c5701` 为 business-design-agent/ba-design、running。仍是原 run，未人为补写阶段完成或中断 Runner。新的 121 启动升级协调器尚未复制到正在运行的副本，不将当前进展当作该协调器的真实升级证明。

- 主链：Context → Plan → Analysis → Dev → Test → Review → 阅读结卡。
- 任务/Execution/工作项绑定、代次与实际节点状态一致；不能用旧游标替代完成事实。
- 交叉检查样例仓库实际 diff、测试证据和产物，不只看页面或执行退出码。
- 遇到真实协助/仲裁请求，核对三次系统尝试及人工兜底动作，不人工伪造次数。
- 所有修复须保留初始错误，并重跑原始场景。
# 追加核验：S1 真实收尾及 BA 评论回流

- Feature `REQ-a964c794-c07e-492f-a0f5-43cb1330c592` 的独立 Review 来源 `519bdd58-1893-4723-8ea2-5af55fd05c31` 已实际 applied；UI 展示结卡报告 v1。读取报告后交叉核对目标仓库 Surefire 的 31 份 XML，共 94 测试、0 失败、0 错误；ISBN 12 项与编目登记 7 项的报告时间为 2026-09-15 07:51:31 UTC。通过正常 UI 点击阅读关闭需求，页面返回需求列表。没有仲裁强制完成或补写执行数据。
- BA `REQ-14735718-7101-41ec-9f62-c5da3f6d4334` 的独立规格 Review 来源 `bbbe40c4-67ed-4007-a3a3-40b546711e0e` 已 applied，图四个上游节点 completed、closure waiting；UI 正常呈现最终规格及阅读入口。但验收表格 A-10/A-11 未转义竖线导致缺列，保留该真实产物问题，尚未确认阅读完成。已从要求修改评论入口提交仅修正格式、保持业务语义不变的反馈，后续须核对保存、图回流、修订后重新审查及完整显示，不把这次点击当作已完成回流。
- 评论保存已由 UI 确认：显示“1 条反馈待处理”，阶段回到需求规格编写，旧最终规格入口不再提供阅读确认，执行数由 6 增至 7。修订与重新审查尚在继续，不能热替换这个正在运行的实例。
- 版本化回流已确认：ba:spec/ba:review/ba:closure 的 revision 1 均 superseded，revision 2 初始分别 running/pending/pending。修订来源 `4deb243f-7301-47cb-a9af-d5b117080fc9` 已实际 applied，新的独立审查来源 `98ea73b0-d23a-4386-a72f-be7eb2ae549d` 已自然派发并 running；尚须核对审查结论、修订表格显示与阅读确认，不能仅凭规格 applied 宣称通过。
- 上述仍是隔离实例 S1 的 590 测试快照，不代表根工作区最新 637 测试代码已完成真实默认启动升级走查。

## S1 收尾与安全切换（2026-09-15）

- BA 修订来源 `4deb243f-7301-47cb-a9af-d5b117080fc9` 与独立复审 `98ea73b0-d23a-4386-a72f-be7eb2ae549d` 均实际 applied；复审 `businessAnalysis.disposition=approved`。正常 UI 读取规格 revision 2，A-10/A-11 中竖线输入及预期异常已正确落在各自表格列，随后点击阅读确认。当前 ba:closure revision 2 completed，需求 done；原 revision 1 和格式问题保留，未改库放行。确认时间 2026-09-15 16:22:18 本地。
- 实际旧 BA 确认活动仍写“结卡报告”，属于 artifact 标签问题，不改写真实历史；最新版已按 BA Closure 使用“需求规格说明书”，后续须核对新一次活动。
- S1 无活动主执行或介入后，通过普通运行面板结束本轮，刷新显示已停止，OS Runner 89242 已退出；之后才停止旧 Web 并更新隔离代码快照。没有热替换运行中的 Runner。

## S2 默认启动与真实 Direct

- 更新的隔离代码快照全量 668 项测试通过。重启 Web 使用 Node 24、fallback Git、独立 `LOOP_APP_ROOT` / `LOOP_DATA_ROOT`，端口 3007；未设置 `LOOP_WORKFLOW_ENGINE`。
- 通过普通 UI 在 Native BA Smoke 项目创建只读 Direct `REQ-b12b7ef4-e9dd-462d-ac4a-f8b96c2d314f`。默认工厂建立 `direct:execute` 原生工作项 `4a25ddac-b7e5-4658-a970-3cc407b7d43f`，revision/epoch 均 1。
- 普通 UI 启动 S2 run `25c40ca2-86ec-4062-b0b1-90b237484f64`；封存启动升级收据，supervision token 4，四个需求的 previousEngine 全为 native。这证明默认协调器入口实际运行，不证明真实历史 legacy cohort 的升级演练通过。
- Direct 来源 `9f1fe708-a5c6-4048-a456-81b90d594cb0` 实际 applied、last_error=null，对应节点 completed。普通 UI 已显示完成并展开真实 Markdown 报告。报告正确保留只读范围与未运行 Java 测试的限制，未用模型总结替代测试证据。
- 只读 Git 复验：library-ba HEAD 仍为 `d869849b5ebaa744eac6fa2444c4522dc2e62d99`，工作树干净，没有额外提交。该 Direct 的预期是只读报告，不要求虚构代码提交。
- Direct Markdown 表格 R2/R4 也出现模型未转义竖线的缺列；原始内容保留，不能将渲染问题当成原生流程失败，也不能宣称全部产物格式已通过。
- S2 启动的是上述 668 项快照；随后根工作区新增的七项报告来源加固尚未加载到该 Runner，不能把这次 Direct 当成该新发布边界的实际走查。

## S2 补充自然入口（运行中）

- Bug Fix `REQ-ca301b13-3f61-4a8e-90b0-5caa62c21a8f` 在 Native BA Smoke/library-ba 创建。预期先真实复现 ISBN-10 末位竖线误接受，再修复、独立测试及正常结卡；不扩展 ISBN-13、不推送或发布。初始基线 d869849，来源 `1e2266a1-d0cb-4a29-b582-4a2f4839dee6` 为 backlog-agent/backlog，绑定 context 节点 `43b4494b-c61c-4e49-aa03-3a70d066fd91`。
- End to End `REQ-8fab9320-d64d-4249-b823-ebd69f77821e` 在 Native Workflow Replay/library-replay 创建，基线为 S1 真正提交 8f84e276。预期完整 BA→交付链，新增无异常 ISBN.isValid 查询及最小真实回归，保持构造器行为。来源 `aea6a508-08df-4cef-b219-bef74d3f5d48` 为 idea-context-agent/ba-intent，绑定 `ea6e9e43-5b51-4ce1-9f2e-a4d1e5f6ce83`。
- 两项均通过普通 UI 创建、同一默认 S2 Runner 自动派发、revision/epoch 均 1；初次只读证据为 running、last_error=null，已持续产生实际 tool_event 收据，不能以启动成功宣称复现、规格、代码或测试通过。
- 根工作区后续 YAML Recovery 与运行信息归属加固也未热替换到 S2；继续保留原运行现场。

## S2 复现与正常澄清恢复

- Bug 的 backlog 来源 `1e2266a1-d0cb-4a29-b582-4a2f4839dee6`、repro 来源 `07913634-e125-4cfb-a11e-d48418b8fea8` 均实际 applied，无 last_error；对应 context/repro 节点 completed。图自然派发 Split 来源 `49d746b7-864f-4e75-aef7-16ee10182775`，绑定当前 plan 工作项，running。尚须读取复现证据及独立 Dev/Test/Review 终态，不能凭 repro applied 宣称修复通过。
- E2E 首次意图来源实际 applied，并提出目标参与者、Git 证据两项正常人工澄清。通过决策页面逐项选择原范围：仅同包预留能力、不接入既有入口；形成本地提交、不推送部署发布。页面保存两项答案后仍需显式整批提交，随后状态恢复需求意图确认。
- 意图恢复来源 `5bf1fbe1-496c-4843-8166-e82fecea35bd` 实际 running、无 last_error，仍绑定原意图工作项 `ea6e9e43-5b51-4ce1-9f2e-a4d1e5f6ce83`，revision/epoch 均 1，独立执行序号 2。未重写数据库、伪造阶段完成或扩大业务范围。
- 根工作区 686 项测试、构建、构建后独立 tsc 及 diff 检查通过。这些加固尚未加载到正在运行的 S2 668 快照，不能把本次恢复当作最新版完整端到端验收。

## 后续静态边界加固（S2 不热替换）

- 契约停滞检测去除规格记录 ID/版本与 JSON 格式差异：原样重交仍累计，实质内容变更才重开窗口。补测重交 revision 2 后计数 3，实质修订 revision 3 后计数 1；未篡改旧失败收据。
- 仲裁完成/回退及普通 Test 收尾不再按整个需求释放代码槽，回退只释放依赖闭包内的来源。首次 690 项全量回归发现三项 Feedback 失败，定位为 Dev 结果仍建立无来源的需求锁；修正为真实 Dev 来源绑定，并让 Test 释放确切上游 Dev 的已结束代码交接锁，保留另一个独立来源的资源。没有把失败归咎于夹具或降低断言。
- 重跑最新全量 690 项测试：690 通过、0 失败；Web 构建、构建后独立 tsc、diff 检查均通过。仲裁完成、回退 Dev、回退 Plan 及普通 Test 通过均验证独立来源的代码槽仍保留；原失败执行证据不改写。
- Bug Split 来源已 applied，当前交付分析来源 `1bac6e4e-5854-4cc5-81f3-9f3b0eedd833` 正常 running，无 last_error。普通 UI 展开真实复现文档，并交叉读取 repro 工具收据 00000018（真实 ISBN 接受竖线）、00000044（登记 Try Success）；实际目标 Surefire XML 记录基线 9 测试、0 失败/错误，Git 工作树仍干净。
- 这些根工作区修复没有热替换 S2；Bug 修复后测试、E2E 全链、多组反馈及系统辅助/仲裁真实走查仍未完成。

## S2 原生介入与前置放行边界

- 通过普通 UI 创建只读 Direct `REQ-077e8a64-9bdf-457a-9037-0209d3a3b06e`，要求读取尚不存在、必须由人工提供的外部环境清单。未创建假清单、伪造外部 Windows 事实或改写状态。实际 Direct 来源 `79c6838f-7e95-493a-9830-1923736c821e` 在节点 `593b6bc9-5f64-4d62-9cc3-33bba6081b5e` 提交缺失证据与介入后 applied，未将原目标声明为完成。
- 介入 `INT-0f07ee2c-b97a-41bf-975a-c8c7030a7e39` 自动派发系统辅助；第一轮来源 `0d1b7313-72d3-4a72-b112-6238f500c58e` applied 后未解决，第二轮来源 `59a05c69-3a4a-4a48-9eb5-469cd095178e` running。普通详情页面实时显示系统辅助尝试 2/3、调查与命令进度、报告尚未生成。第三轮与人工兜底尚不能宣称完成。
- 已关闭 Feature 的普通页面不提供评论或重开入口，未改库重开制造多组反馈验收；多组反馈需在 Bug 报告等待阅读时通过真实评论提交。
- 前置需求放行新增检查：除了 Closure 的依赖边，同需求所有当前原生义务也必须结束。补测一个无依赖边的独立验证节点：报告已生成也不能放行，节点完成后才放行。根工作区最新 691 项测试全通过，Web 构建及构建后独立 tsc 通过；S2 仍运行原 668 快照，不能充当这一新门禁的真实运行验收。
- 最终文档阅读与前置放行仍需进一步统一产物来源证明：当前 Closure 检查图义务及同需求文档头，而 Review 的原生发布已有来源收据，BA 与历史采纳的证明路径须一起设计，不能仅依赖旧文档字段。此项未宣称已修复。
- 随后第三轮来源 `6df2dcf1-6d54-4818-9496-05488076f103` 实际运行但漏交 resolve/defer，记录 system_blocked 及具体错误“系统辅助 Agent 已退出，但未执行 resolve 或 defer 终止命令”。介入实际达到 attempt_count=3/max_system_attempts=3 后 awaiting_human；普通页面显示等待人工仲裁、当前没有运行 Agent、报告尚未生成。这是两次主动未解决加一次真实执行失败，不宣称三次成功提交 defer；人工裁决终态尚未完成。

## 最终文档来源统一（根工作区，S2 不热替换）

- 新增 work-item-artifacts，共用最终文档身份、发布节点、来源与结果证明。Review 收据补记正文摘要，BA 最终规格发布新增同类来源收据；历史 Closure 一次性采纳时封存文档 ID、阅读版本与内容摘要。普通采纳调用不会重新相信已被改写的文档头。
- 阅读确认、前置放行和原生详情投影使用同一证明。补测历史文档头/版本/正文/收据损坏，以及真正领域命令应用后的 Feature/BA 发布文档被替换、正文被改写、结果应用失败、结果内容损坏、冻结来源或发布收据损坏；均不放行且证据仍可读取。旧 Review 无摘要收据必须匹配实际已应用结果中的产物正文。
- 首次 697 项回归中四项原生报告原子发布测试失败：新门禁错误地要求执行状态已 applied，忽略结果与完成节点已在同一事务应用、执行状态随后收尾的时序。修正为已应用来源结果、完成发布节点及有效执行状态的联合证明，并在报告事务标记结果应用后刷新投影；未降低测试断言。
- 最新 697 项全量测试全部通过，Web 构建通过。隔离 S2 仍为 668 快照，不宣称新文档门禁已获真实 Runner 复验。
- Web 构建完成后独立 tsc --noEmit 退出 0，git diff --check 通过；没有并发读取尚在生成的 Next 类型文件来替代此检查。
- S2 实际 Runner PID 51295 及 Web session 25899 仍存活。Bug 分析来源 `1bac6e4e-5854-4cc5-81f3-9f3b0eedd833` applied，自动进入 Dev 来源 `d51f216d-c283-4f5a-b97c-41185739b9a9`；实际 library-ba 出现 ISBN 字符类去掉竖线与新增拒绝竖线的 Groovy 用例，尚未产生提交，独立 Test 未完成。E2E 意图恢复来源 applied，自动进入业务方案来源 `ca12750a-3418-4b21-9531-9efd3cb7e4f0`，普通页面显示对应命令链；未人工补写阶段或扩大需求范围。

## 取消、仲裁完成与显示边界继续收口

- Feedback 完成按原生图义务与可信最终文档投影，不再由兼容游标清空报告头、修改阅读状态。真实领域发布后的正文被污染时，不允许阅读或放行；修复正文后重新投影，无需重写图账本。
- 正常暂停/恢复保持同一工作项，但已取消的来源不能创建新的 Recovery 介入或写声明/验证收据；已经存在的不可变指令仍可幂等读取。Dev/Test 两类来源均有回归。
- 仲裁直接完成活动 Dev/Test 时，取消目标节点的活动主来源，保留已发生的原失败与冻结输入。真正领域迟到结果返回 discarded；人为注入事务故障时，取消、图完成、事件与介入解决全部回滚。没有取消其他独立工作项的来源。
- 实际 Direct 介入已 awaiting_human、没有运行 Agent，S2 概览仍写“运行中”。根工作区修复为从最新非 superseded 的原生 direct:execute 节点读取状态；待输入/介入、就绪、暂停、缺图均不会推断为正在运行。
- 704 项全量测试通过后，独立 tsc 发现新增仲裁测试的两处 Lane 字符串类型错误。修正为角色对应的明确 Lane，重新跑 704 项全量测试全部通过、独立 tsc 退出 0。Web 构建通过；S2 仍不热替换。

## S2 Bug 实际交付及正常反馈（继续运行）

- Bug Dev `d51f216d-c283-4f5a-b97c-41185739b9a9` 实际 applied；只读 Git 核对 library-ba HEAD 为 `32f4b9dd0b6e0c6ed22b72d432d975ebfc784f9b`，两文件修复、工作树干净。旧 S2 此 Dev 来源的 code_commit 列仍为 NULL，不能说该列与 Git 一致；根工作区此前已有实际 Git 收据回填修复，需最新版实例再验。
- 独立 Test `f5b0fad6-3580-47bd-b722-a7d7866404b5` applied，基线为上述真实提交，实际结果 13 场景通过。目标仓库 BookTitleAuthorISBNTest Surefire XML 记录 10 测试、0 失败、0 错误。这里不声称 Bug 的全仓库测试总数。
- Review `253020c4-434b-45e1-837a-90f2bad94af4` applied；普通页面自然进入等待阅读结卡、图 delivery:review completed、closure waiting。真实报告列明受影响测试、限定桩化、未运行数据库 IT、不推送部署发布的边界。
- 未确认关闭，通过普通报告评论入口提交两条独立要求修改：报告验证证据表格修订；仅追加 trim 包裹竖线/小写 x 的常驻构造层回归，保持既有 10 测试及生产实现不变。页面确认两条评论均保存。首条批次已经冻结后才提交第二条，后者待分流，不能假称同一冻结批次包含两组。
- 首条实际反馈来源 `ad0eb28e-c600-414a-8c07-b89707cc52bf` 为 feedback-agent/feedback-triage，绑定 `feedback:triage:4ffd0f46-02e2-42cd-9ba6-8c5d7e8a827c`，running、无 last_error；尚未证明报告回流、追加交付与逐评论验证完成。
- E2E 业务方案来源 applied 后等待两项正常人工决策；普通决策页面选择构造器唯一权威、需求枚举最小测试集，并显式提交完整答案批次。后续同节点恢复及完整交付仍待实际来源核验，不把点击提交当成执行完成。

## S3 真实历史需求创建、采纳与正常恢复

- 独立现场 `/tmp/loopwork-upgrade-smoke.dwIfjD`，app detached worktree HEAD 169da7d，端口 3008，独立 data；样例 library 的基线 d869849、工作树干净。不是生产仓库，也不复用 S2 数据。
- 先运行 HEAD 的真实旧版 UI，设置 Native Upgrade Legacy Replay 项目并保存 Codex/Luna Runtime。普通 Direct 创建 `REQ-df993ad9-389e-4139-a897-f09e875de311`，仅只读 ISBN/Git 核验；普通暂停按钮保存原因。升级前只读数据库确认执行 0、run 0、没有 workflow_items/workflow_upgrade_receipts 表，没有改库伪造 legacy。
- 正常停止旧 Web 后备份独立 data-old-backup，才机械复制最新源码并启动新 Web。普通“开始运行”建立 run `6ec8554b-e84a-4d49-af79-29f7c1460099`，Runner 12450；升级收据 previousEngine=legacy、itemCount=1。任务 title/description/project/pause 原因逐值比对保留，native direct:execute `f03b4cc0-bce4-43fe-99dc-90b74869ecb7` ready/revision1/epoch1，但暂停期间执行仍 0。UI 原“执行节点运行中”改为“已暂停”。
- 普通结束本轮后 OS Runner 12450 消失，run stopped/failure_reason=NULL；普通重新开始 run `82cdf3ef-7a75-4063-af66-93d25c3fe6de`，Runner 13173，收据 previousEngine=native，旧 item ID/revision/epoch 保持，native:adopt 事件仅一次。
- 普通恢复需求后实际 Direct 来源 `2a02e4dd-39e3-417d-8724-6c52c8449d46` applied/last_error=NULL，绑定原节点，节点自然 completed，UI 已提交。真实报告确认 ISBN 字符类接受末位竖线，明确记录 git status 因本机 Xcode license 返回 69，不虚报该命令通过。另用 fallback Git 只读复验目标 HEAD 仍 d869849、工作树干净。
- 无活动主执行后正常结束本轮、Runner 13173 消失，再停止 Web，更新 707 项验证快照并重启 Web session 77204；没有热替换 S2。此冷边界升级实测不能替代 Windows 实库活跃来源排空、代次恢复及路径验证。

## 冻结上下文与 Review 草稿授权继续迁移

- 原生 getTaskContext 只读加载当前原生图及依赖，不做 adoption。冻结快照新增 WORKITEM/INTERVENTION 按需资源和当前工作项；兼容生命周期标为 display_only。Agent 完成原因不作为 Test 证据；仲裁完成/理由与已解决介入分别冻结，原 Test 失败不改写。压缩/最小恢复使用确切引用，不内联全图。
- 新回归发现需求级 Review 需要所有单元的裁决 refs，修正单元筛选；原生 Context 读取无图账本写入的断言使用真实 event→item 关联查询。706 项重新全部通过。
- Review 发布已原生化，但旧草稿仍以 in review/current_subagent 拒绝原生来源。原生草稿改验真实来源绑定、冻结代次、当前运行节点、依赖/介入和报告基线；单元数量从图投影，续跑模式从绑定节点读取。旧历史分支保留。新增真实领域开始来源后污染旧 done/Agent/closure/999 单元/全部游标的回归，输入阶段仍可完成；普通暂停取消来源后命令被拒绝，冻结输入/哈希保持。
- 707 项全量测试全部通过，Web 构建完成后独立 tsc 退出 0，diff 检查通过。S3 最新快照已更新；后续新来源的实际冻结 Context 读取仍继续验证，S2 不冒充此增量。

## S2 两个真实反馈组的进展

- 报告修订组 `9f56c536-dc83-400b-98f1-05b3e6272974`/isbn-report-evidence-table/report_correction 已 completed；实际反馈验证来源 `cabed882-e3c4-462e-9c6f-ccdae78f5e52` applied。普通 UI 查看报告 v2：13 场景的场景/实际结果/来源三列完整，竖线输入未拆列，保留原提交 32f4b9d、10 测试、数据库 IT 未运行等限制。
- 后提交评论独立分流为 `137e1d76-96bd-44a2-ad99-a030717b190f`/isbn-constructor-regression-guards/technical_change，当前 waiting_for_plan；真实 feedback-split 来源 `1e5986ef-8f94-468b-b338-038f461196d9` running。未将后到评论塞入已冻结首批次，也没有漏掉它。代码追加、独立测试、报告合并及最终关闭尚未完成。
- E2E 业务方案恢复来源 `fe42659c-b4a1-463a-a2d2-f11c90763697` applied，保持原 `8fffb912-79c2-498a-b701-1f3038d1c397` 节点，自动进入规格来源 `28ba149a-00e7-4e8c-a2e8-2cac438cae28` running；全链终态仍待实际验证。

## 709–710 项收口：仲裁到 Review 的完整授权链

- 发现 Test 仲裁完成后，Review 对账仍强制要求 Test passed，可能重复形成结卡阻塞。修复为复用现有 reconciliation/evidenceRefs：只有当前原生 Test 的冻结 WORKITEM、已解决仲裁 INTERVENTION 及不可变 complete 事件一致，才允许同范围的明确例外；Dev 仲裁不能替代 Test，单元裁决不能冒充其他单元或需求级验证。
- 同范围对账必须引用工作项和介入两条证据并保留完整裁决原因；评估证据边界列出二者，报告 verification/risks 保留工作项引用与未验证限制。仲裁资源始终 independentTest=no，原始 Test 失败不改写，最终报告仍须由真实 Review 来源提交。
- 两条实际领域命令链回归覆盖 Test 仲裁可形成 report_ready、缺少介入引用拒绝、仲裁权限污染拒绝、报告遗漏边界拒绝，以及 Dev 仲裁不能豁免独立 Test 证据。冻结输入/哈希不变。
- 初次全量发现 builtin YAML 不接受 instructions 属性；撤回该非法属性，说明放回现有 builtin 编译器与冻结 Context Prompt，不扩展 YAML schema。修正后 709 项全量测试、Web 构建、构建后独立 tsc 和 diff 检查全部通过。
- 第三条多单元领域回归新增 unit 2 的明确 Test 仲裁和仅属于 unit 2 的通过证据夹具：unit 2 对账可接受例外，unit 1/需求级对象仍拒绝通过。原生普通 Test 通过证据也按当前单元范围组合核对，不再任意引用一个 passed 就覆盖全部单元。最新 710 项全量测试全部通过，Web 构建、构建后独立 tsc 和 diff 检查通过；该夹具仅在领域测试，不注入真实冒烟数据库。

## S3 最新冻结 Context 的真实读取

- 普通 UI 新建 `REQ-b2821ab0-244c-47b5-8442-20971a44d815`，正常启动 run `978a2984-05fb-4535-bffe-543786864704`，Runner 31646。
- 实际 Direct 来源 `6b9cca4f-c198-433a-a754-7d36f1702f5d` applied、last_error=null；冻结模型 work-item/intervention，当前 `WORKITEM:3ecab507-7b6a-485b-8630-5de70386c57f:r1`，epoch=1，生命周期 authority=display_only。
- 实际工具收据证明 overview、list --scope current、get WORKITEM 均成功，报告列出真实字段并区分节点完成与测试通过。错误相对路径自行纠正，真实 Xcode license 错误如实记录，未伪称 Git 命令成功。独立 fallback Git 核对目标仓库 clean。
- 实际终止命令提交文档后正常结束本轮，Runner 31646 已消失，用户原实例未改动。此实例快照为 707，不能冒充后来新增 709 仲裁门禁的真实 UI 走查。

## S2 追加回归与 E2E 继续自然推进

- 追加反馈实际 split `1e5986ef-8f94-468b-b338-038f461196d9`、analysis `c6c2661f-df00-4cc0-8ee0-1e7ce0547269`、dev `940d2715-c022-4fa4-9322-724ba25772b9` 均 applied；真实提交 `e26c39851a062eb6bc9e75453c2073510c65cec4` 仅新增两条永久 Groovy 回归，不改 ISBN 生产代码，原十条测试保留。
- 实际 Surefire XML BookTitleAuthorISBNTest 为 tests=12/failures=0/errors=0/skipped=0；独立 Test 来源 `907ab9be-55ea-420a-92de-27196287f63e` 尚 running，不能以 Dev 自测代替 Test applied、反馈验证或报告合并终态。
- E2E 规格 `28ba149a-00e7-4e8c-a2e8-2cac438cae28`、规格审查 `11fdcbcd-b701-4d4c-aac9-3bafe6a3195e`、backlog `79244cae-0bab-42de-b11a-f73307ef852d` 均 applied，进入 split `a9e375b3-a59a-4a06-b28a-69c080811ad4`；未通过 DB 注入结果或提前宣告全链完成。

## 712–719 项收口：真实孤儿执行、取消竞态及只读检查

- S2 旧内存池以 taskId:lane 去重。实际 feedback-verify 来源 `a814d895-0b6c-4d2e-9039-ecb2ad485fef` 已 planned、节点 running，却没有 CLI/工具收据；同需求 control Lane 上的 Review 占住内存键，独立来源未启动。修为 execution ID 内存键，既允许同 Lane 不同工作项，也允许同节点取消来源收尾时启动新来源；同来源仍去重。712 项全量测试、构建及构建后独立 tsc 通过。
- 普通 UI 结束本轮后确认旧 Runner 51295 消失、run stopped/failure_reason=null，才停 Web、更新隔离 S2/S3 的 712 快照，不热替换活跃代码。S2 正常重新开始 run `3322fd2e-aa02-4857-ad33-75f19db04dfd`、Runner 57412；原反馈验证的新来源 `d6d54c59-69fe-4396-bd4b-33022402b291` 实际 applied/last_error=null，已不再孤儿挂起。独立 Test `907ab9be-55ea-420a-92de-27196287f63e` 已 applied。
- 同一旧现场的 Review `ff6fed35-4c14-4127-affa-c4f761cba5e3` 能读取新原生草稿，但反馈验证在其运行中完成，改变冻结 subjects 后门禁正确拒绝发布。Review 提交仲裁，不冒充结卡完成。系统辅助来源 `4ad69ee2-2414-4356-95db-a6e8709783d2` 实际 applied，核对真实 Git e26c398/32f4b9d 及两个独立 Test 来源，复用 task-rewind 将 delivery:review 换为 revision 3；介入 `INT-3c6be191-fdb1-440b-8f08-0012c28b9192` 实际 resolved。新 Review 来源 `c992aee2-7a72-477e-923b-c99ebf28373b` running，尚不宣称新报告及最终阅读完成。
- 根工作区补齐追加单元重新创建 Review 后的 feedback-verify 依赖；冷启动从已有反馈图修复此依赖，仍不重新采纳可变 batch/group 终态。新增领域测试污染 cancelled/completed 旧字段，节点、版本、冻结上下文不变，缺失依赖恢复，Review 不提前派发。
- 真实详情页 inspect 调用 planner 在 SAVEPOINT 内仍写投影，S2 遇到 database is locked。根工作区把原生 inspect/inspectAll 改为纯只读队列与只读失效资源判断，不做 reconcile、投影或释放失效资源；旧投影模拟仅留在显式测试适配器。新增 query_only=ON 测试证明详情及全局检查都不写，total_changes 不变、历史资源不删。
- 真实普通结束本轮还暴露先 kill CLI 后取消来源的竞态：退出回调可能误计 agent-cli-exit；旧回调还把 Loop 停止写为“需求已取消”。根工作区正常停止先取消活动未提交来源，再终止进程。来源级原因区分暂停、正常停止、换代、仲裁和真正任务取消；迟到 cancel 不覆写已取消/失败/应用事实。新增停止顺序触发器及迟到失败回归证明取消先于进程终止阶段、零重试消耗、冻结输入不变、原真实失败保留。
- 系统辅助的取消判断不再读取 agile_status 的旧 done/cancelled 显示标签。只有真实 current_execution_id 所属的介入来源可忽略自己正在解决的任务级 hold；主来源或错误引用不能借此绕过 hold，真实暂停仍停止辅助。新增冻结来源回归覆盖上述边界。
- S3 正常 run `05746fc9-e2f0-46c0-a70f-b2ce515aa486`、Runner 59977，新 Feature `REQ-f5ba89ce-d0dd-4493-99e5-2b9cbd63e9ca` 实际 backlog 来源 applied。普通页面确认 ASCII 数字/大写 X 的原始需求边界并提交完整决策批次；恢复来源 `0c9ba952-46c4-422d-a7ed-164633c50c7d` running，完整 Git/Test/报告仍继续走查。E2E Split applied，恢复分析来源 `887ddd03-769b-4d2b-a754-505b408d0dd0` applied 并提出预期构造器异常边界澄清；按原需求正常回答，不吞掉非预期故障。
- 根工作区最新 719 项全量测试全部通过，718 快照的构建通过，随后独立 tsc --noEmit 退出 0；719 仅新增停止顺序测试，没有追加生产代码。S2/S3 仍运行 712 快照，不能宣称后来只读检查、取消竞态与依赖补齐已完成真实实例复验。Windows 生产实库活跃来源迁移与路径仍未验收，不发布、不提交、不推送。

## 720–721 项收口：原子停止与实际 Bug 终态

- 补查系统辅助迟到回调：Source 已因正常停止 cancelled，但退出结果仍可能为 code 1。Runner 及 finishInterventionAttempt 同时检查真实取消来源，辅助 attempt 记 cancelled/介入回 pending，不改写来源、不消耗 failed/deferred 尝试额度。领域回归以正常停止后真正调用 finishInterventionAttempt 验证，720 项全量测试通过。
- 正常停止的 Source 取消、资源释放及 run stopping 派发屏障现于同一 immediate 事务提交，再终止进程树。Runner 无法在取消与本轮关闭间派发替代来源。新增故障注入令 stopping 写入失败，Source 与完整 run 行均逐值回滚；保留取消先于进程终止阶段的原测试。首次该回滚测试误写 fixture run 必须 running，实际 beginRun 自然为 starting；改为完整原 run 行比对，没有伪造心跳状态或降低回滚断言。721 项全量重新通过、构建通过、构建后独立 tsc 退出 0、diff 检查通过。
- S2 Review `c992aee2-7a72-477e-923b-c99ebf28373b` 实际 applied/last_error=null，正常生成最终报告 v3。普通页面阅读全文：真实 Git 32f4b9d/e26c398、13 场景独立验证来源、12 个永久构造层测试、独立 feedback-verify 来源、两反馈组及数据库 IT 未运行/未发布边界均保留。没有把系统辅助的裁决当成 Test passed。
- 普通“我已阅读结卡报告并关闭需求”后只读数据库确认 task done/closure acknowledged、阅读与完成时间 `2026-09-15 10:26:22 UTC`；delivery:review revision3 completed/authority=agent，delivery:closure revision3 completed/authority=human；两组 Feedback 皆 completed。随后 fallback Git 复核 library-ba HEAD=e26c39851a062eb6bc9e75453c2073510c65cec4；当前仍有旧隔离 Agent 生成的未跟踪 `.loop-feedback-answer-review.md`、`.tmp/`，不能宣称工作树完全干净，保留它们而不删除现场。实际 Surefire XML tests=12/failures=0/errors=0/skipped=0。
- E2E 异常边界批次真实 resolved，恢复分析 `fedf20d9-60c7-42b4-9075-2da042389665` applied，自动进入 Dev `b361bb4b-08a1-4040-80f5-f90878d232e4` running。S3 最新 Feature backlog resume 与 split 均 applied，Analysis `f73b3109-97a0-4b10-8cf7-e94534aaaf2e` running。这两条完整交付仍未到终态；S2/S3 仍为 712 快照，后续 721 增量需在安全停止后更新复验。

## 722 项增量：真实开发状态与 Git 来源一致性

- 两个隔离 Runner 57412/59977 以 OS 进程核对存活，不因来源仍 running 就推断进程存活。实际旧快照的第一个 Dev 已运行，却因 dev_index=0 仍显示“等待推进”。根工作区投影改为依据 Dev/Test 节点状态显示开发阶段，未把进行中节点当成完成或提前增加游标。领域测试真正开始 Native Dev 来源，ready 前显示等待、running 后显示 in dev、dev/test 计数仍 0，读取不改变图。722 项全量测试全部通过、Web 构建通过、构建后独立 tsc 退出 0。
- E2E Dev `b361bb4b-08a1-4040-80f5-f90878d232e4` 实际 applied/last_error=null，来源 code_commit=93a02d58020cbdc9975361918177fd3e95ec9804；只读 fallback Git 核对目标 library-replay HEAD 完全一致。真实 diff 仅 ISBN.java 与 BookTitleAuthorISBNTest.groovy，两文件 57 insertions/1 deletion，内容为不抛预期输入异常的 ISBN 有效性查询及最小回归。进入真实 Test `ed9fcb97-aae3-44b5-9281-14e615424ce1` running；尚不宣称 Test 或结卡完成。
- S3 Feature analysis applied，进入真实 Dev `068ffa6c-78ef-4339-a100-4a5d9074a0d4` running；对应 codex PID 83116/83197、E2E Test PID 85413/85438 均以 OS 核对存活。继续原始范围，不写假结果、换简单场景或改库推进。S2/S3 仍为 712 快照，722 增量仍需安全更新后真实复验。

## 验收清单收口与新 Feature 独立测试

- ADR 改为单一当前测试基线 722，历史项数保留在本时间线。将已真实完成的 Bug、多单元/两批次反馈组及历史冷采纳从剩余事项移除；保留 E2E/新 Feature 最终闭环、最新快照安全更新复验、人工实际裁决提交和 Windows 活跃生产来源升级边界，未扩大完成声明。
- S3 新 Feature Dev `068ffa6c-78ef-4339-a100-4a5d9074a0d4` 实际 applied/last_error=null，code_commit=e8e0e803189867f1e46bf2896121737442ff5317；只读 fallback Git 核对 library HEAD 完全一致。仅 ISBN.java 与永久 Groovy 测试两文件，13 insertions/2 deletions；真实 Test `79f812fa-04c7-4e1d-8cfb-fd2a0fbeae87` running。E2E 原 Test `ed9fcb97-aae3-44b5-9281-14e615424ce1` 仍 running，无新失败，不冒充完成。

## 724 项增量：完成门禁覆盖全部当前义务

- 横向检查发现 nativeCompletionInDb 仅排除未结束 Feedback，已阅读 Closure 可能遮蔽其他新建当前义务。改为检查同需求全部当前 native Work Item；Feature/BA 两项领域回归使用真实发布与阅读路径，再添加独立验证义务，确认未启动依赖不放行、整个工作图不误判结束，原 Closure 及账本逐值不变；完成新增义务后自然重新满足终态。13 项针对性测试、724 项全量测试全部通过，Web 构建及构建后独立 tsc 退出 0，diff 检查通过。
- E2E 独立 Test `ed9fcb97-aae3-44b5-9281-14e615424ce1` 实际 applied/last_error=null，普通概览显示 4 场景通过并自动进入 Review `119fd1c7-f8ac-4aae-91dd-8195900916a4`。目标 Surefire XML 的 BookTitleAuthorISBNTest 实际 tests=14/errors=0/skipped=0/failures=0。Review 尚未发布，不替代阅读结卡。
- S3 Feature Test 实际 applied/needs_input，未假报失败修复或成功。实际介入 `INT-8d60fece-a0f4-403f-ab67-5e3af83cd20e` authority=standard，问题是冻结合同要求 frontend 业务闭环，但 package-private ISBN 领域类没有真实 UI/API；普通概览显示系统辅助第 1/3 次并实际派发辅助来源。保留原需求及真实缺失事实，不生成假的前端入口或观察结果。S2/S3 仍为 712 快照，724 增量仍需安全更新复验。

## E2E 实际阅读结卡与 724 冷启动

- S2 E2E Review `119fd1c7-f8ac-4aae-91dd-8195900916a4` 实际 applied/last_error=null，报告 v1 保留本地 Git 93a02d5、独立 Test EXEC/DOC 引用、96 项测试与未启动数据库 IT 的边界。只读目标 Surefire 31 份 XML 聚合 tests=96/failures=0/errors=0/skipped=0，与报告一致。普通 UI 阅读报告后点击结卡，任务从进行中列表移除；持久化 task done/closure acknowledged，时间 `2026-09-15 10:40:26 UTC`；Review completed/agent，Closure completed/human。
- 普通 UI 结束 S2 run `3322fd2e-aa02-4857-ad33-75f19db04dfd` 后 Runner 57412 以 OS 检查消失、受管进程无 running；run stopped/failure_reason=null。正常停止 Web session 66815，数据恢复副本为 data-before-724，冷复制并 checksum dry-run 确认相关源码/命令链/迁移一致。新 Web session 23817、server-native-724.log、同端口 3007/独立 LOOP_APP_ROOT/LOOP_DATA_ROOT，HTTP /tasks=200。
- 普通 UI 开始运行，实际新 run `b23bdb3b-b8f0-489e-9942-5c8b8d0f84f5` running/heartbeat 存在/failure_reason=null，Runner 96177 以 OS 确认存活；启动封存收据 supervisionToken=6，已有 7 需求 previousEngine=native。只读与备份比对 Bug/E2E 的全部工作项、账本和来源身份/冻结输入/哈希/状态/原错误/代码提交/额度逐值不变，不重复采纳或重写历史。
- 通过正常 UI 在 Native BA Smoke / Direct 创建最新候选的只读长命令需求 `REQ-c2cde65f-0438-4350-a76d-c3675acac0ef`。范围只读 ISBN/Git，90 秒无写入诊断等待以观察活动执行正常停止回调；恢复时保留同一原始需求/工作项，不制造失败或结果。活动停止/恢复仍待验证。
- S3 原 frontend 缺失介入的实际 attempt 1/2 已 deferred，第三次真实 running；系统辅助核对无 UI/API 并真实运行 Maven，没有伪造 frontend 观察。继续同一需求，不换 Pipeline 或缩小原始验收。

## 725 项增量：活动停止的代码槽泄漏修复与真实复验

- 724 的普通 UI 停止只读来源 `0904f48d-55b9-4be1-85b2-889cfad250fb` 后，run stopped/failure_reason=null，Runner 96177、CLI 96332 和真实 90 秒 Node 子进程 97191 均消失，Source cancelled/零错误额度/冻结输入不变；但确切来源仍持有 code:workspace。此真实遗漏不能以浏览器等 execution-scope 资源已释放代替。
- executions 取消路径按实际 owner_execution_id 且真实 status=cancelled 清理全部自身资源；迟到 cancel 保留 applied 的 Dev 交接槽和其他来源资源。调度失效资源检查只识别同任务的真实取消 owner：只读返回忽略且不改库，实际刷新才清理历史遗留槽。领域回归覆盖 applied 交接不删、只读 query 保留取消遗留行、调度刷新删除、迟到取消不覆写原因、其他来源资源逐值不变。第一轮测试因夹具在代码槽已占用后创建另一来源而被正常资源门禁拒绝；修正夹具创建顺序，未放宽门禁。
- 8 项针对性测试全部通过；725 项全量测试、Web 构建、构建后独立 tsc --noEmit 及 diff 检查全部通过。日志分别为 `/tmp/loopwork-native-code-release-725-tests.log`、`/tmp/loopwork-native-code-release-725-build.log`、`/tmp/loopwork-native-code-release-725-tsc.log`。
- S2 正常停止 Web 后冷复制 725，checksum dry-run 一致，新 Web session 45086/server-native-725.log。普通启动 run `8fc1a8a3-e68a-4fda-9a62-ae8a00a1002e`、Runner 99395；原需求仍使用 `8afe4d89-5c97-4a8a-b923-a8617fdc6326`，新来源 `a834b97e-cdd2-4aff-8801-eddbe0c72d36` 自然 applied/last_error=null，真实完成 90 秒命令和 direct submit，目标代码未变、code_commit=null。遗留代码槽正确移交给新来源并在提交后释放；原取消历史不重写。
- 通过正常 UI 创建 `REQ-3827ac6d-c6f9-4e23-868d-bc259497de6f`，仍仅只读 ISBN/Git 和实际原时长 90 秒命令。最新来源 `d7978619-b31d-46da-bcf4-58e73763e3a4` 绑定 `2c831592-07f5-43c3-bf7f-272787ecf89b`，真实 CLI 2413、Node 长命令子进程 4384 存活且 code:workspace owner 为该 Source。正常“结束本轮”后只读检查 cancelled/last_error=Loop 已停止（用户停止）/failure_kind=null/dispatch_retry_consumed=0，资源为空，run stopped/failure_reason=null；冻结 input_json/input_hash/节点/attempt/代次逐值不变，OS 99395/99409/2413/4384 均消失。正常“开始运行”产生 run `cb742d4e-4ef8-4106-a5fa-74bd4d675c03`、Runner 4670，新来源 `a47bff7a-e7e5-48aa-a5ea-a1d5c9ba5676` 同节点 attempt 2 运行，最终提交仍待核验。
- S3 frontend 介入 `INT-8d60fece-a0f4-403f-ab67-5e3af83cd20e` 三个实际系统辅助来源均 applied/deferred，转人工后普通 UI 保存“无真实前端且不能伪造观察”的事实答案。保存本身只 resolve 介入；页面仍提供显式“提交验证协助并交回验证 Agent”，点击后实际新 Test 来源 `dd251ff5-2009-48aa-90f8-805c1b5dd9dc` 运行，说明此前 waiting 并非恢复故障。Test 又提交新的验证协助，未自动提交仲裁；新介入仍待实际处置。
- S3 712 正常“结束本轮”后 run stopped/failure_reason=null，受管进程无 running、Runner 59977 消失，再正常停止 Web session 50036。备份 data-before-725 后冷复制并 checksum 验证，最新 Web session 16004/server-native-725.log、同端口 3008；普通启动已发起。旧快照的新辅助来源 `49ea8438-5e71-4939-a635-9aed3a79fba6` 在停止时记了 code 1，保留真实历史，不在升级时改成取消；最新 725 的迟到取消回归不能伪称该旧来源历史已修复。

## 最后旧版恢复残留移除与停止恢复闭环

- S2 同节点恢复来源 `a47bff7a-e7e5-48aa-a5ea-a1d5c9ba5676` 实际 direct submit 成功并 applied/last_error=null，`2c831592-07f5-43c3-bf7f-272787ecf89b` completed，代码槽为空。真实恢复又完整执行 90 秒命令；未把上一条被手动中止的命令写成通过，原 Source cancelled/零错误额度保留。
- S3 最新代码槽快照普通启动 run `9b9e3c8e-2830-4f7a-8510-05aa2aed88a4`、Runner 5695，failure_reason=null。与 data-before-725 只读逐值比对全部 13 个历史来源的状态/输入/哈希/绑定/原错误/代码提交/额度、33 条账本完整行和 6 个已完成工作项完整行一致。首次只读查询误以 loop_runs.created_at 排序，修正为真实 started_at；无数据库写入。
- 第三次真实辅助来源 `3808a168-78bc-4d7b-b54a-d56a1555e0f7` applied/resolved，介入 `INT-e72cd280-d4c0-471d-bd2c-6380da3404e0` resolved/system-assistance-agent。实际 Maven 10/0/0/0，并独立反射观察数字/X/竖线/小写/trim/非法首位/null；明确前端不存在、没有接受 Xcode license、数据库 IT 未运行。普通辅助没有仲裁豁免权限，不能把领域观察当 frontend 或替代 Test；后续实际 Test `fb0172c2-ea20-4822-ab43-86c687fbd0ae` running，门禁和最终报告继续核验。
- 静态横查发现普通 applyNextQueuedAgentResult 仍调用 requeueLegacyFeedbackPlanResultsInDb，按旧错误文本覆写 failed 结果、清除 source.last_error、修改旧游标并重新排队。移除该历史恢复分支；原旧回归改为完整源/结果/任务不变、显式采纳后产生 Intervention、再次队列轮询不改图/账本/介入、不追加失败规划单元的回归。采纳仍只在明确升级边界，原始失败不会因轮询而消失。
- 直接 tsx --test 首次缺少标准隔离 setup 被保护拒绝；正确补 --import ./src/test/setup.ts 后 30 项针对性测试全部通过。最后增量 725 项全量测试、Web 构建、构建后独立 tsc --noEmit、diff 检查全部通过；日志 `/tmp/loopwork-native-no-legacy-requeue-target-tests2.log`、`/tmp/loopwork-native-no-legacy-requeue-725-tests.log`、`/tmp/loopwork-native-no-legacy-requeue-725-build.log`、`/tmp/loopwork-native-no-legacy-requeue-725-tsc.log`。两实例仍为代码槽 725 快照，尚未冷更新此最后结果队列增量，不能将同项数误认为源码逐值一致。

## 726 项增量：真实 Test 结论绕过 CLI 错误重试，立即进入工作图

- S2 空闲后正常结束 run cb742d4e/Runner 4670，OS 进程消失，正常停 Web；备份 data-before-no-legacy-requeue 后冷复制最后旧队列移除增量。新 Web session 75060/server-native-no-legacy-requeue.log，普通启动 run `c543f4da-aa90-4e3d-972d-8da3e354d506`、Runner 10610、supervisionToken8。只读比较全部 72 个历史来源的冻结/失败字段、58 个工作项完整行、256 条转移账本完整行不变；没有将已完成任务重开或重复采纳。
- S3 实际 Test `fb0172c2-ea20-4822-ab43-86c687fbd0ae` 提交有效 verdict=failed/failureKind=specification/rewindTo=analysis：frontend 不存在与禁止新增 frontend/API 的契约矛盾；领域观察是补充，不冒称 frontend passed。但 Runner shouldRetryReportedFailure 在结果应用前将其标 retryable_failed，理由为“Agent 提交失败结果，将按统一策略重试”，未进入原生回退。此实际缺陷说明仅测试 applyAgentResult 的回退处理不能代替入口路由核验。
- shouldRetryReportedFailure 现在接收真实 delegation.agent；经过角色终止命令验证的 Test failed 结论立即交给现有结果应用/工作项回退/介入机制。无 Test verdict 的执行失败仍统一四次重试，其他角色或未提供可信角色不会仅凭 verdict 推断 Test。新增纯策略回归及 Runner 调用接线回归，原原生角色失败应用回归保留。
- 30 项针对性测试、726 项全量测试、Web 构建及构建后独立 tsc --noEmit 全部通过。日志 `/tmp/loopwork-native-test-verdict-routing-target-tests.log`、`/tmp/loopwork-native-test-verdict-routing-726-tests.log`、`/tmp/loopwork-native-test-verdict-routing-726-build.log`、`/tmp/loopwork-native-test-verdict-routing-726-tsc.log`。
- 普通 UI 正常结束 S3 run 9b9e3c8e；run stopped/failure_reason=null、受管进程无 running，Runner 5695/5710 OS 消失，活动重试 `baa36c76-33d5-4366-948b-695935bd2329` 正常 cancelled。备份 data-before-726 后冷复制全部源码/命令链/迁移，checksum dry-run 一致；Web session 46173/server-native-726.log。普通启动 run `110baea2-c710-4e13-a9a3-e34fc8e84f7e`、Runner 12908，新真实 Test `f8211b2b-b79f-4caa-ae71-146e821c8760` 同节点 d5b35f92/revision1 运行；原 failed/cancelled 来源保持历史，最终路由与可信报告仍待自然执行验证。

## 727 项增量：采纳边界收口与真实 Test 回流结果

- S3 真实 Test `f8211b2b-b79f-4caa-ae71-146e821c8760` 自然提交 completed/verdict=failed/failureKind=specification/rewindTo=analysis；agent_results 为 applied/effect_outcome=rewound/application_error=null。原 Test 节点随回退 superseded，Source cancelled 是工作图换代的结果，不是 CLI 错误；原结果 JSON 保留，dispatch_retry_consumed=0/failure_kind=null，input_hash=b9a3be61dcc3ad682d220a9edb7a11083036944dcc7d21d46f981f6375647dca。旧 Analysis/Dev/Test/Review/Closure revision1 全保留，新 Analysis revision2 来源 `3c0ba8d5-7c59-4aec-8205-b43bdbb02b81` 实际 applied，进入 Dev `69d5de5d-baec-4606-b002-016452f6f25b`。未伪造 frontend passed，未先重试四轮 Test，也未改写旧 fb0172c2 的真实错误。
- 普通结果队列现在仅选择 workflow_engine=native 的未暂停需求。真正 Legacy 工厂创建的未采纳需求，即使持有更早的损坏 pending 结果，也不抢占 Native 来源；源、结果、任务、原 legacy_projection 图逐值不变，无隐式 native 采纳或 Intervention。首次测试误以为 Legacy 工厂不创建投影图，改为比对真实原图而非要求图不存在。旧 Review 队列测试改为显式 native 采纳语义，过期 Review 的新增单元由真实 appendDeliveryWorkItems 追加并 supersede 冻结来源。
- 重试应用失败测试改用真实 Native 来源及前四次实际 failExecutionWithRetryPolicy；第五次真实执行的损坏结果触发 source-bound waiting Work Item 和 arbitration Intervention，不伪造 attempt 编号，也不要求旧 runState 标签作为阻塞事实。
- 现有 intervention request 帮助和验证门禁错误明确提供调查后已回答但无法解决的阻塞出口；保留原契约和独立证据，不重复索取已确认不存在的材料、改写 Oracle 或伪造通过。阻塞结果仍不能 phase complete。
- 68 项队列/恢复针对性测试及 41 项队列/命令帮助针对性测试全部通过；最新 727 项全量测试、Web 构建、构建后独立 tsc --noEmit 和 diff 检查全部通过。最新日志为 `/tmp/loopwork-native-queue-and-intervention-guide-727-tests.log`、`/tmp/loopwork-native-queue-and-intervention-guide-727-build.log`、`/tmp/loopwork-native-queue-and-intervention-guide-727-tsc.log`。S2 暂为旧队列移除 725 快照，S3 为 726 Test 路由快照；以上根工作区验证不冒充 727 的隔离冷启动或 Windows 实库验收。

## 727 最新快照安全冷启动与历史逐行保留

- S2 只读确认没有 running/reserved 来源后，普通 UI 正常结束 `c543f4da-aa90-4e3d-972d-8da3e354d506`；run stopped/failure_reason=null，受管进程无 running，Runner 10610 以 OS 确认消失。正常停止 Web session 75060，备份 `data-before-727` 后 rsync 冷复制 src/app/scripts/command-chains/migrations/docs，checksum dry-run 无差异。没有热替换 S3 活动 Dev。
- 新 Web session 3444/server-native-727.log，独立 LOOP_APP_ROOT/LOOP_DATA_ROOT，原端口 3007，HTTP /tasks=200。普通 UI 开始运行，新 run `2bd68289-8684-4cdd-9e73-cf56e81fafa2` running/runner_pid=20435/failure_reason=null；OS 确认实际 Runner 存活。
- 只读对比备份全部 execution_attempts 72 行、workflow_items 58 行、workflow_item_events 256 行，完整行逐值无变化；冻结输入、原错误、错误额度、节点版本及完成/仲裁事实都未重写。不是只比较数量，也没有通过改库制造升级成功。
- S3 保持 726 原 Test 入口修复快照继续原需求：Analysis revision2 实际 applied、Dev `69d5de5d-baec-4606-b002-016452f6f25b` running。可信报告及正常阅读结卡仍待完成；Windows 生产活跃来源迁移和人工最高裁决的实际终态仍未以本轮冷启动替代。
- 随后该 revision2 Dev 自然 applied，进入独立 Test `599248ec-b0f9-4b46-b0e5-5005f2ffa6bd` running。两来源 base_commit 都是原真实提交 e8e0e803189867f1e46bf2896121737442ff5317，未制造新 code_commit；初次失败 observation 保存原失败签名、契约内容指纹、仓库提交和 stagnantCount=1。第二轮结论仍未产生，不将没有改代码的 Dev 总结当成独立验证通过。

## 桌面实际打包边界复核

- 使用 scripts/build-desktop-runtime.mjs 相同的四入口、external=[better-sqlite3,next/cache]、CJS/node22 配置完成内存构建；377 个输入文件没有 src/test 夹具，包含 work-items/interventions/workflow-upgrade/work-item-transitions，实际生成四个 CJS bundle。迁移 113–121 均存在，桌面构建脚本复制整个 migrations/command-chains；没有把仅 packages=external 的较弱测试冒充实际依赖打包验证。
- runtime-workflow-boundary 回归改为上述真实打包配置，断言完整模型/升级模块及四入口数量。针对性测试通过，最新全量 727/727、独立 tsc --noEmit 退出 0、diff 检查通过；日志 `/tmp/loopwork-native-packaged-boundary-727-tests.log`、`/tmp/loopwork-native-packaged-boundary-727-tsc.log`。本增量只修改回归测试与记录，没有热替换两隔离 Runner 的生产代码；先前 Web 构建仍为相同生产源码。CJS 编译不替代 Windows 安装包、原生 ABI 或生产历史实库验收。
- S2 最新 727 实例实际 UI 确认：缺少真实外部清单的 Direct 仍等待人工仲裁，系统已尝试 3 次；展开人工表单只提供 direct:execute 回退，不提供 Dev/Test 强制完成。未为了制造终态而提交无依据的回退、补造外部环境材料或假报任务完成。

## 验收职责确认

- 用户明确回复“windows 验收我自己来做，你保证本机环境没问题就行了”。Windows 实机/生产实库由用户负责，本地验收不再等待外部 Windows 资料；仍明确 CJS/Web 编译、macOS 进程恢复不能替代 Windows 原生 ABI 和实库证据。本地原始 Feature 的最新代码、仲裁处置与可信报告仍须完成，不因验收分工而减少本机闭环要求。

## 最新 Feature 冷更新与最高仲裁实际推进

- S3 普通 UI 正常结束 run 110baea2；run stopped/failure_reason=null，受管进程无 running、Runner 12908 OS 消失；活动 Test `0d155a1b-9fae-409b-a915-df0126945d0f` cancelled/dispatch_retry_consumed=0/failure_kind=null，保留正常停止原因。正常停止 Web session 46173，备份 data-before-727 并冷复制/checksum 一致。新 Web session 30165/server-native-727.log、HTTP 3008/tasks=200；普通 UI 启动 run `0cc19a02-1752-4a61-a88b-1d6b099a1c8e`、Runner 27201。23 个历史来源、55 条账本完整行和 11 个 completed/superseded/cancelled 工作项逐值不变。
- 同 revision2 Test `455ccec7-b73d-40a5-aea1-b93becaaafd3` 实际执行 intervention request，COMMAND RESULT=submitted/Agent Action=end_execution；来源 applied/dispatch_retry_consumed=0/failure_kind=null，结果 applied/effect_outcome=blocked。介入 `INT-85abe80d-309f-4266-86b3-77d5247ac702` 精确关联原 Test 工作项及该来源，authority=arbitration。没有制造 frontend 通过或重复索取材料。
- 系统辅助来源 `4bc06acc-3534-4a81-a35a-8ad906fd7f01` 实际 applied，第一次即可依原规格、源码、永久 Groovy 测试和实际 Maven 10/0/0/0完成裁决；Test 节点 completed/completion_authority=arbitration、完整理由保留缺少 frontend/未跑数据库 IT 边界，介入 resolved/system-assistance-agent。来源 f8211b2b 的原 failed/specification 结果及完整源行与冷更新备份相同；未改为 passed。新 Review `e080f4f4-112e-4a94-8785-fb90886f3045` 实际 running，可信报告仍须核验。

## 人工最高裁决的额外真实 Feature 场景（创建前预期）

- 使用 S2 最新 727 实例、NativeWorkflowReplay 项目及隔离 library-replay，普通 Feature 入口；不是改用 Direct 代替 Dev/Test 仲裁。目标只追加空字符串/纯空白 ISBN 的永久 Groovy 回归并本地提交，生产 Java/API/数据库不变。
- 独立 Test 另需读取刻意缺少的 `/tmp/loopwork-native-smoke.xXVZsw/human-acceptance-cases.json` 人工案例，不允许任何 Agent 补造材料、声称该案例已测或擅自跳过人工前置。分析/Dev 可依据描述中的明确输入先完成本职；到 Test 缺少材料时用现有 intervention request。系统三次真实无法解决后由正常页面明确裁决，保留未执行事实；报告必须引用人工裁决且不能宣称缺失案例通过。
- 创建前目标 HEAD=93a02d58020cbdc9975361918177fd3e95ec9804，实际 git status --short 为空；不将另一个 library-ba 现场的未跟踪文件误记到该仓库。案例文件实际不存在；不为通过而提前补写文件、改库或替 Agent 提交内部命令。
- 普通 UI 创建实际需求 `REQ-29e7dc31-3dbd-4049-9627-04d1af35bfc4`，项目 PRJ-bff747b0-f7c2-4ede-b2c9-459911568433/item_type=feature/workflow_engine=native；原输入的 missing-case 文件及禁止系统擅自跳过条件均真实保存。页面显示 Develop、原始输入锁定、当前需求梳理。实际 Backlog 来源 `ea12171a-ccce-4e7a-b73c-5fc85ad977cf` running，未宣称最终人工裁决已发生。
- S3 Review e080f4f4 的持久化冻结 input_json 有 contextSnapshot，包含仲裁工作项 WORKITEM:e1c6fa3b-e9c8-4f6a-a96a-7d4afe61838e:r2 和已解决 INTERVENTION:INT-85abe80d-309f-4266-86b3-77d5247ac702；明确携带“仲裁完成不等于独立测试通过”。裁决已进入下一阶段的真实输入，不是只检查可变页面标签。

## 仲裁理由的 YAML 换行兼容：真实偏差与原场景复跑

- Review e080f4f4 实际提交 needs_input，而非 report_ready：冻结工作项与 Intervention 引用正确，但 reconciliation.result 经 YAML folded scalar 改变换行，原完整多行 resolution 的精确子串检查拒绝所有对账。真实介入 INT-609f90bc-0998-4cb4-a58d-865db4aa823e 由系统辅助来源 0b5c1293-5b55-4716-97a3-97fbe59f8bed 处理；实际 appliedCommand 是 intervention task-rewind 到 delivery:review，不是强制完成 Review。Review/Closure revision2 superseded，新 revision3 正常派发。保留其总结声称“可以完成”与实际命令的区别。
- 修复只归一化报告对账文字中的空白，要求完整裁决原因仍出现；数据库完成事件、Intervention 权限/解决者/原因、冻结上下文身份仍精确匹配。两个检查共用同一规则，避免已经保留原因却又在 Test 证据覆盖检查中拒绝。缺失引用、截断原因、改变 unverified 为 verified、跨单元借用通过证据以及陈旧权限均继续拒绝。
- 原生 Review 回归使用实际 YAML folded scalar、字面多行以及 CRLF/tab 表示同一完整裁决，且验证未生成 independentTest: yes。针对性 8/8、全量 727/727、本机构建与构建后独立 tsc --noEmit 均通过；日志 /tmp/loopwork-arbitration-whitespace-{target-tests,727-tests,727-build,727-tsc}.log，diff 检查通过。
- 普通 UI 正常结束 run 0cc19a02，stopped/failure_reason=null，受管进程全部退出且 Runner 27201 OS 消失；来源 8a6be272 正常 cancelled。正常停止 Web、备份 data-before-arbitration-format-fix 后冷复制源码，checksum 无差异。新 Web session 97928、server-native-arbitration-format-fix.log，HTTP 3008/tasks=200；普通 UI 启动 run 3e5989dc-ec7b-4e78-b5b1-eeda80da4b02，Runner 54539，新 Review 8df27862-62ef-4a70-bf17-e1aa64e9aa82 绑定原 revision3 工作项 0ff66245-0a0c-41e0-98c3-ac93c28a18fb，未改原需求范围。
- 冷更新备份的 26 条终结来源、66 条不可变工作项事件以及 14 个 completed/superseded/cancelled 工作项完整行与启动后逐值一致。可信报告与实际阅读结卡仍待运行结果核验，不把测试通过或新来源 running 当作原场景闭环完成。

## Review 正常停止/恢复后的冻结草稿版本

- 原 revision3 Review 8df27862 自然发现另一条不可通过的门禁：旧 editing 草稿仍持有 EXEC:8a6be272 的旧状态，新执行快照包含 EXEC:8df27862，产生证据变化和未冻结证据错误。根因是 ensureDraft 直接重绑 editing 草稿到新 execution，不是原 Dev/Test 证据被篡改。Agent 同时发生 macOS sed 参数误用，其真实工具失败保留，不混同为 Harness 缺陷。
- 修复 Review 的跨执行草稿绑定：新执行始终创建下一版本，通过现有 Review clone 路径重新冻结 inputs、重新对账，不改写旧草稿、旧快照，不忽略证据变化，也不保留未经新输入复验的旧结卡输出。其他角色草稿策略不变。
- 原生 Review 回归从真实 pauseTask/resumeTask 域动作开始，重新派发同工作项并构建包含旧 cancelled Review 的新上下文；新 draft_version+1，frozen inputs 阶段正常完成，旧草稿及所有旧 artifact blocks/原 input_json/input_hash 逐行保持不变。针对性 8/8、全量 727/727、Web 构建、构建后独立 tsc --noEmit 通过，日志 /tmp/loopwork-review-resume-context-{target-tests,727-tests,727-build,727-tsc}.log。
- 普通 UI 正常结束 3e5989dc，run stopped/failure_reason=null，受管进程无 running，Runner 54539 和 CLI 54605 OS 消失；正常停止 Web 97928，备份 data-before-review-resume-fix 后冷复制并 checksum 确认一致。新 Web session 84755/server-native-review-resume-fix.log，普通 UI 开始 run 28f95525-f654-4b58-ab86-74ce295c91a5，Runner 59765 OS 实际存活。
- 同原 Review revision3/item_id=0ff66245 新来源 8457a73b-e93d-471f-93a4-1a656ba71acd 正常 running，真实新草稿 a29cb6e0-3309-4a54-b027-f9f84cdecc4a/version2；27 条终结来源、68 条账本、14 个封存节点、15 个旧草稿和 220 个旧 artifact blocks 完整行与冷更新备份逐值一致。blocks 按实际四列复合主键比较，不把只用 draft_id 命中第一行的错误诊断当作内容变化。
- 独立最终审计回归覆盖五 Pipeline 工厂、统一队列、领域失败回流、四次执行恢复、人工动作、介入生命周期、启动迁移、需求依赖及实际桌面 bundle 边界，91/91 通过；日志 /tmp/loopwork-migration-completion-audit-tests.log。原需求可信报告与新人工仲裁 Feature 终态仍须真实核验。
- 额外人工 Feature 的分析 797e9647 实际 applied；Dev 05c9bdbf-d051-449b-8215-1a696b06a95d 已 applied/effect_outcome=advanced/application_error=null，真实永久 Groovy 测试形成提交 4fb5a75，后续最终 code_commit=6b8e4ee5413a26617055d2c5bf7653c89d4cbbc8。保留其真实 dispatch_retry_consumed=1，不概括为零错误执行。目标 Surefire BookTitleAuthorISBNTest 为 15/0/0/0；缺失人工案例文件仍不存在，独立 Test c74d00a9-b06f-46d8-8c24-960e9b776a16 正常 running。未代 Agent 提交、未接受 Xcode 协议、未补造人工案例；实际人工裁决仍待出现。

## 完整仲裁理由由 Harness 确定性保留，而非 Agent 重抄

- 原 Review 8457a73b 实际 applied/needs_input/dispatch_retry_consumed=0，虽引用正确 WORKITEM/INTERVENTION，仍因概述而非逐字重抄长裁决被拒绝。它没有伪造 report_ready。新介入 INT-add77f64-83bb-4d73-bf99-31c14a982f95 实际由辅助来源 0cd22d40 解决，appliedCommand 为 intervention task-rewind 到 delivery:test:1；新 Test revision3、Review/Closure revision4，旧 Test 仲裁节点及历史结果保留。该回退是实际 Agent 决定，不是报告闭环或测试通过。
- 替换上一轮空白子串兼容方案：对账继续要求同范围两个结构化引用，完整裁决由 Harness 从通过身份校验的权威记录直接写入“仲裁处置记录（Harness 权威证据）”。Agent 可忠实概述结果和未验证边界，无需重抄多行 Markdown。没有弱化完成事件/介入/权限/解决者/工作项 revision/epoch/冻结快照逐值匹配，没有将 Dev 仲裁变成 Test 通过，报告明确仲裁放行不证明原失败已修复。
- 回归验证折叠/CRLF/概述均不改变最终报告原裁决全文；报告包含原完整 reason 与两个引用，且没有 independentTest: yes。缺失引用、跨单元借证据、过期权限、截断权威 resolution、篡改不可变完成事件仍拒绝。针对性 15/15 和补充权威性 8/8，全量 727/727、构建和独立 tsc --noEmit 通过。日志 /tmp/loopwork-canonical-arbitration-{report-target-tests,authority-target-tests,report-727-tests,report-727-build,report-727-tsc}.log。
- 普通 UI 正常结束 run 28f95525，run stopped/failure_reason=null，受管进程全部退出、Runner 59765 OS 消失；Web session84755正常停止，备份 data-before-canonical-arbitration-report，冷复制源码/checksum 一致。新 Web session29513/server-native-canonical-arbitration-report.log，普通 UI 启动 d20baaf6-f16c-4fd6-bcd5-799314122a3f，Runner67560，新 Test2867cf28-2f91-4e68-b756-66222a52bf5d绑定原 revision3/item62260564-075d-4d03-a59e-c834b49d255b。
- 30 条终结来源、76 条账本、16 个封存节点、17 个旧草稿、292 个旧 artifact blocks 全行逐值不变；artifact blocks 按完整复合主键校验。最新原场景仍在运行，尚无可信报告/阅读结卡，不将编译器回归替代实际闭环。
- 额外人工 Feature 的 Test 实际提出 runtime 输入（不是创建前期望的主动仲裁请求），形成标准介入 INT-7ab4bb38-7788-4164-91b3-7d3c2c062238。系统辅助 463df070 实际 applied，其 attempt1 状态 deferred：只读确认人工 JSON 不存在，未把场景定义文件当作人工原始案例，未写文件或伪造观察。另行 Maven 命令出现旧 Groovy/当前 Java 初始化失败，没有声称新的通过收据。介入保持 pending，attempt2 来源 cd7c7142-2056-48b0-8699-d7038edbc4f4 实际 running；仍需三次未解决后的真实人工处置与最高裁决核验，不把标准输入答复冒充仲裁完成。

## 当前迁移版本提交边界

- 四个实际 CJS 入口补充 Node 子进程加载验证：compiled loopctl 在隔离空生产数据库初始化五张统一模型表，lifecycle-host 导出可加载，loop-agent 与 runner 正确拒绝无授权/缺少 run id。没有注入测试夹具；该检查不冒充 Windows 原生 ABI 或完整安装包验收。针对性 1/1、全量 727/727、独立 tsc 通过，日志 /tmp/loopwork-compiled-runtime-boot-{target-tests,727-tests,727-tsc}.log。
- S3 原 Feature 的 Test revision3 经真实辅助来源 ae038f75 与介入 INT-b8bc16d2 仲裁完成；Review a3f924a0 实际 applied/advanced，发布文档 494ff9ef。只读检查最终报告包含完整权威 resolution、WORKITEM/INTERVENTION 引用及 Harness 仲裁处置记录，明确前端黑盒和数据库集成测试未运行。页面已进入等待阅读结卡，尚未点击阅读确认。
- S2 标准输入介入实际三次 deferred 后转人工。安全冷更新逐行保持 80 个来源、65 个工作项、276 条账本、17 个介入、7 次尝试、58 个草稿与 1628 个产物块不变。普通人工保存答复后节点仍 waiting；明确提交验证协助后才 ready，并记录 human 的 resume 事件，原三次尝试不变。
- S2 同一 Test 节点恢复后来源 b476bf0f 实际提交 intervention request，形成仲裁 INT-f359c7b2；未重复索取同一文件、未把缺失案例当通过。目前人工最高仲裁及后续报告的实际终态仍未验收完成。本次提交是已实现迁移与修复的阶段版本，不将目标标记完成；不推送、不打 tag。
- 用户随后明确要求注册中心代码一并提交。最终提交范围包含命令/Builtin 注册中心、类型提取及相关回归和技术债记录，不再单独留出注册中心改动。合并后全量 727/727、本机正常 Turbopack 构建及构建后独立 tsc --noEmit 均退出 0；日志 /tmp/loopwork-migration-with-registry-commit-{tests,build,tsc}.log。此前隔离迁移快照的 723 项检查不替代此次合并版本验证；人工最高裁决的最终真实闭环仍保持待验收。
