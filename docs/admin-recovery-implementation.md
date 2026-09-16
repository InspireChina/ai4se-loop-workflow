# Admin 自动修复闭环实施记录

目标：Agent 出错后能够调查、换方法、实际修复、独立验证并恢复业务推进。
Admin 的启动不能依赖正常业务 Runner、业务 ready 队列或普通 Agent 槽位。
次数耗尽用于升级解决方式，不用于将 Agent 故障转交人工。

## 全量交付范围

1. 底层终止可靠性：停止、重启、迟到结果、重复事件、日志失败；实际进程退出后才能启动冲突写入。
2. Lifecycle / Execution 边界：提取运行控制与单次调用协调，注入进程、时钟和存储，续租不被清理阻塞。
3. 独立 Admin Controller / RepairCase：故障去重、持久化尝试、接管代次、停止与监督约束，支持 Runner 或业务数据库不可用。
4. 实际修复 / 独立验证：诊断、复现、接管、修复、回退、重测、版本校验和交还；不得直接将 Dev/Test 标记通过替代验证。
5. 统一 Recovery Policy：退出未提交、无进展、重复失败、策略升级；外部等待需要证据、持久化冷却与自动探测；保留真实人工输入。
6. 宿主恢复与 Harness 自修复：启动监督、OS 托管、防休眠、准确源码、隔离构建、外部切换、启动失败回滚、数据库兼容，并更新 ADR 0001。
7. 故障注入与真实 Agent 验收：完整覆盖文档列出的故障路径，进行 8–12 小时整夜运行，检查完成量、恢复时间、重复写入、进程与资源残留和验证真实性。

统一入口为观察归一化 → 恢复决策 → 管理动作执行；不得将各类错误处理继续堆在 Runner 主循环。
RepairCase 由管理模块统一维护，Intervention 仅表示业务阻塞并关联修复记录。
用户主动停止时业务与管理修复均停止；接管限定故障范围，不中断无关独立任务。

## 隔离数据库兼容读者与真实端口回滚（最新轮次）

实现 SQLite 在线备份、完整结构/原数据投影、执行迁移 SQL 内容比对及真实新旧安装版本读者。自动切换采用保留旧读者与旧数据的扩展策略；未知未来迁移、旧约束/对象变化及原数据改写被拒绝，不能恢复旧数据快照去强行回滚。校验期间真实源数据变化会使副本失效。

读者具备持久化分配、实际身份、私有父通道与统一退出排空；Native stop/cancel 也检查读者屏障。未知空 PID 不允许重复启动，超时先实际杀死进程组。详见 [外部更新协议](external-runtime-update.md#隔离数据库读者与自动回滚兼容门禁)。

最新全量 1015 项、13 项定向检查、独立 `tsc --noEmit`、隔离 Next/Desktop 构建全部核对退出 0。真正打包 Electron 在 `/tmp/loopwork-installed-db-roundtrip.GYRdg2` 使用非 stub 数据兼容端口完成 6 次校验、10 个独立读者与真实宿主回滚；所有实验进程均退出，原 Case 未关闭、用户停止及零业务运行保留。原失败/原验收与实际后续业务恢复仍不能由这些受控证据代替。

生产版本选择/OS 更新入口、schema 不兼容升级的桥接策略、Runtime Harness 实际修复路径、Windows 容器、三条真实模型修复与整夜验收仍未完成。完整目标不变；没有提交、推送、清理工作区或启动用户业务 Loop，3000 工作台仍 HTTP 200。

## 安装产物身份与真实宿主私有激活（此前轮次）

新增实际安装字节清单、持有式启动分配记录及原生更新适配器。父子进程绑定真实 PID、父 PID、启动身份、进程组和私有连接；迟到登记不能覆盖另一身份，ready/activation 不能跳阶段。恢复时来源不明的空 reservation 保留屏障；只有当前实际 spawn handle 能证明未创建进程时才结束空分配。Windows 根进程退出不能替代容器退出证明。

全量 1006 项、43 项定向检查、独立类型检查、隔离 Next/Desktop 构建全部已核对退出 0。实际打包 Electron 宿主在私有数据目录通过故障候选排空、已知版本监督权和私有激活验证，最终子进程均退出；保留用户停止、原 Case 和零业务运行。完整证据与限制见 [外部更新协议](external-runtime-update.md#当前验证证据)。

完整目标保持不变。数据库副本新旧读者验证、生产根目录选择与 OS 更新入口、Windows 容器、三条真实模型修复及整夜运行还没有验收；本轮受控产物副本故障和 stub 兼容端口不能替代这些证据。没有提交、推送或启动用户业务 Loop。

## 外部更新事务、激活门禁与数据库读者保护（此前轮次）

本轮推进 Stage 6B 的外部控制内核，尚未接入生产原生外部进程适配器和真实版本替换。

- 增加独立更新租约、单活事务、不可变原/候选产物身份、阶段与分页事件历史。恢复决策不在业务 Runner 内，不占业务或 Admin 执行槽位。
- 固定阶段协议支持持有式候选启动、激活、启动健康观察、失败排空及回滚。物理退出未确认不推进；回滚前重新验证实际数据兼容，不恢复旧数据库快照。
- 普通宿主重启/普通更新恢复不能解除未结束事务的静默。专用租约激活入口校验阶段、当前租约、实际安装目录和 package 版本，只恢复业务侧更新状态；外部管理屏障保持到健康结束。原 RepairCase 不因启动健康而关闭，Dev/Test 不被直接标记完成。
- 应用与业务数据库在 journal/schema 写入前拒绝当前读者未知的已应用迁移。首次检查发现本机历史库的两个已停用扩展误判；已加入可空字段/无活动引用/兼容外键等明确历史校验，不删除迁移记录，不豁免其他未知迁移。本机 `/tasks` 已恢复 HTTP 200。

本轮验证与终态：

- 18 项新增测试，全量 **999 pass / 0 fail / 0 skip**，exit 0，`/tmp/loopwork-external-update-full-tests.log`；23 项针对检查通过，`/tmp/loopwork-external-update-targeted.log`。
- 独立 TypeScript exit 0，`/tmp/loopwork-external-update-tsc.log`。冻结 Next 构建 exit 0（最终 1 条动态追踪警告），`/tmp/loopwork-external-update-next-build.log`。Desktop runtime 构建 exit 0，`/tmp/loopwork-external-update-desktop-build.log`。
- 两个编译后的实际数据库入口在私有 SQLite fixture 上拒绝未来迁移，验证原文件字节与业务数据不变，journal 仍为 DELETE。未知历史数量 101 项不会被有限预览截断为“已知”。
- 最终安装树边界检查通过；实际安装源码身份 `b57c4cf1747db416657e5b056f98859d4c9a0fbeaecce898fa5e68cf4200c4b8`，Build ID `upCWimk-bXwrV6HI_nqhN`，与当前实际工作区一致。
- 真实 Electron Node ABI 执行安装后的宿主入口，在私有库保存受控未结束更新后初始化/退出，exit 0、stderr 空、PID 13165 已消失。只读复查保留 intent running、mode update-silence、owner null、阶段 stopping、原 Case 身份；Admin attempts 0、business runs 0。不是实际候选版本切换或模型修复验收。
- 最新私有证据 `/var/folders/cq/4n_2stz915975plmrvgsgh_w0000gn/T/loopwork-installed-update-guard-final-5RBJ1t`。本机 3000 `/tasks` HTTP 200，主 Management intent stopped，未启动业务 Loop，未提交/tag/推送。

下一步必须接入实际外部进程/私有 IPC、不可变安装产物校验与选择、数据副本的新旧读者兼容验证，并实测坏候选回滚、恢复原业务任务。还需 Admin Harness 修复管理能力、Windows 原生进程容器、三条真实模型业务修复闭环与 8–12 小时整夜验收。迁移名门禁和注入式内核测试不能代替这些交付。设计说明见 [外部运行版本更新](./external-runtime-update.md)。

## Harness 准确源码与冻结构建（此前轮次）

当前轮次补齐 Stage 6B 的准确源码与隔离构建入口，尚未完成版本切换、回滚和数据库兼容。

- `npm run build` 从当前实际源码（包括未提交修改）生成内容寻址快照，在私有临时目录还原并复制独立依赖树，直接编译冻结源码。构建失败、源码变化或回执缺失不能继续打包旧产物。
- Desktop runtime 携带压缩源码与无业务依赖的外部还原工具。测试存在归档数据中，不进入运行时模块解析。工具验证完整归档和实际安装版本/Build ID，只写入安装目录外新建的私有工作区。
- 源码明确排除命名凭据、本地 `.env*`、数据库、日志、临时输出和依赖，拒绝符号链接、硬链接及跨平台不安全路径。这不是秘密内容扫描器、安全容器或发行签名。
- ADR 0001 保留历史删除决定，改由受监督 Admin 修复协议逐步替代，不复活旧 Maintenance Runner，不将仲裁状态推进当修复通过。

本轮真实验证：

- 6 项新契约测试通过；全量 **981 pass / 0 fail / 0 skip**，终态 exit 0，`/tmp/loopwork-harness-source-full-tests.log`。
- 独立 `tsc --noEmit` exit 0，`/tmp/loopwork-harness-source-tsc.log`。
- 冻结源码 Next 构建 exit 0（3 条动态追踪警告），`/tmp/loopwork-harness-source-next-build.log`；Desktop runtime 构建 exit 0，`/tmp/loopwork-harness-source-desktop-build.log`。
- 实际安装源码标识 `435364c9cb83aeae569a73fa2f0662d991eb3039ba034e83d4e16cf1cd88b582`，Next Build ID `XpOenuGyKObtcQQBAUCyT`，版本 `0.1.20`，546 个文件。用安装后的外部工具还原后重新收集内容散列，与归档及当前实际工作区一致；包含新测试与 migration 125。
- 最终安装树边界检查通过；真实 Electron Node ABI 执行安装后的 `host-service.cjs`，初始化后通过私有 IPC 正常退出，exit 0、stderr 空，PID 45177 已消失。只读复查 Management DB：intent stopped、mode normal、owner null、attempts 0。
- 私有证据目录 `/var/folders/cq/4n_2stz915975plmrvgsgh_w0000gn/T/loopwork-installed-harness-source-7ypidE`，保留还原源码与宿主日志/数据库。本机用户 Web 仍仅使用 3000，`/tasks` HTTP 200，未启动业务 Loop。

余下：Admin Harness 诊断/修复能力、外部更新控制与候选启动门禁、自动回滚与数据库版本兼容、Windows 原生进程容器、3 条真实模型修复后业务推进闭环、8–12 小时真实整夜验收。以上来源验证和受控宿主初始化不等于这些验收完成。实现说明见 [Harness 自修复](./harness-self-repair.md)。代码未提交、未打 tag 或推送。

## OS 宿主托管与独立入口（此前轮次）

- 新增无 Web 的独立宿主入口，复用生产 `createManagedLoopRunLifecycle`，在加载业务库模块之前绑定显式 app-root / data-root，包括固定该 data-root 的 global DB 路径；继承的旧路径不能改绑别的工作区。版本读取实际 package.json，初始化日志不宣称业务恢复成功。停止宿主保留独立管理库用户意图；优雅 IPC 也支持不能真正投递 SIGTERM hook 的 Windows 控制父进程。异常、拒绝和退出写 UTF-8 宿主日志；清理失败保留 30 秒强退看门狗，但不删除后代退出屏障。
- 新增纯配置生成器及 CLI：launchd KeepAlive / ThrottleInterval、systemd Restart=always / KillMode=control-group / 无频次熔断、Windows 当前交互用户 Limited / IgnoreNew / 无三天期限 / 电池可运行 / 无限分钟周期触发。只写新配置，不隐式注册或覆盖 OS 作业；区分本机 output-dir 与目标 config-root，拒绝相对 / 控制字符路径和未实际应用的 Windows desktop PATH。明确区分桌面直接 `--hidden` 与独立 Node / Electron 入口，均使用同一 Lifecycle。
- Windows 独立包装内容以 EncodedCommand 启动，审计副本与注册内容一致；包装进程传实际 PID。宿主绑定真实父 PID / 创建身份，廉价存活检查每秒独立运行，创建身份每 30 秒异步复核；慢查询不阻塞存活检查。丢失 / 无法确认父宿主时只关闭当前宿主，不误杀被复用父 PID 的其他进程，也不遗留永久脱离托管的旧宿主。原 CLI 后代仍需真实物理确认。
- 实际通过两项临时 launchd 故障注入：一项强杀后换 PID、保持用户 stop / 零 Agent；另一项保持应用 / 业务数据库损坏、使用缓存配置启动受控 CLI，强杀原宿主，等待真实租约失效后在原 Case / 原始故障不变的前提下恢复第二代独立 Admin、确认旧 CLI 不存在，再保存用户 stop 并确认新 CLI 退出。没有修改租约时间、修复者宣布通过或仲裁完成 Dev/Test。另强杀专用包装父进程，观察其独立宿主实际退出、stop 保留且没有修复尝试。
- 桌面产物增加 `host-service.cjs` / `host-configure.cjs`，实际编译的九条入口不含测试调度器 / 创建 fixture。构建终止后最终安装树门禁通过；随后从真实 Electron Node 可执行文件运行安装树的独立宿主，读取实际打包版本，初始化 / 私有 IPC 退出码 0、stderr 为空，管理库 stop / normal / 监督权已释放 / attempts=0。再从同一安装树运行配置生成器，返回 registered:false，不需要源码、tsx 或仓库依赖。原生产物证据保留在 `/tmp/loopwork-packaged-host-service.Np9dt2`。

新增 **18 项检查**，相关路径 **21 项通过**，`/tmp/loopwork-host-service-targeted.log`；最终全量 **975 项通过、0 失败、0 跳过**，`/tmp/loopwork-host-service-final-tests.log`，已核对退出码 0。独立 `tsc --noEmit` 退出码 0，`/tmp/loopwork-host-service-final-tsc.log`；隔离 Next 构建退出码 0，仍有两项动态追踪警告，`/tmp/loopwork-host-service-next-build.log`；桌面运行目录构建退出码 0，`/tmp/loopwork-host-service-desktop-build.log`。`git diff --check` 通过，3000 工作台 HTTP 200；全部测试 OS 作业已 bootout，不安装生产服务、不新增 Web、不启用主工作区业务 Loop、不提交 / 推送 / 打 tag。操作说明与边界见 [OS 宿主托管](runtime-host-service.md)。

**完整目标仍未完成**：本轮是 macOS 实际 OS 进程 / 受控 CLI 证据，不是三条真实模型业务修复，也不是 Windows Task Scheduler / Linux systemd / 实际桌面应用 OS 重启真机验收。托管尚未作为设置中的自动启用 / 更新交付；Windows guardian / Job Object、未知启动窗口和 POSIX 逃逸后代仍不能靠宿主 PID 消失当退出证明。阶段 6B 的准确源码、隔离修复 / 构建、外部切换、启动失败回滚、数据库兼容和 ADR 0001，阶段 7 的真实模型闭环 / 8–12 小时整夜证据，以及原目标中其他当前仍列出的恢复 / 诊断 / lineage / 超大集合 / 外部等待项均保持全部范围，未判定完成。

## 共享宿主防空闲休眠与取消竞态（此前轮次）

- 新增独立的宿主防休眠协调器。仅当独立管理库的运行意图为 running、模式为 normal、当前宿主持有未过期监督租约时申请断言；绑定 intent revision / fencing token。每五秒独立复核，不排在业务数据库访问、业务监督串行队列或 Admin 进程清理后面。停止、更新静默、租约失效、宿主退出均释放；异步申请期间停止会立即 abort，迟到句柄只能清理，不能恢复运行。
- 桌面入口注入 [Electron `prevent-app-suspension`](https://www.electronjs.org/docs/latest/api/power-save-blocker/)。独立 Node 入口使用原生 helper：macOS `caffeinate -i -w <host pid>`；Linux `systemd-inhibit --what=idle` 托管 stdin EOF 退出的小型 Node 调用；Windows 在单独 PowerShell 进程的同一调用线程申请 [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate) 的 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`，stdin EOF 退出并复原。慢速初始化不阻塞管理宿主事件循环，带就绪 / 取消 / 退出期限和有界 stderr 诊断。
- 这些是临时防空闲休眠能力，不保持屏幕常亮、不修改永久电源配置，也不承诺阻止用户主动休眠 / 合盖 / 关机。Linux 依赖可用的 systemd-logind 及其授权；缺失或拒绝会写宿主诊断，不能算已经获得 OS 断言。
- 申请失败而物理退出尚未确认时保留只能清理的句柄；释放失败不能另起同类 helper。并发健康 tick 合并，不因慢速申请累积无限队列。旧断言释放期间其他宿主停止 Loop 时，在下一次申请之前重新读取真实意图。宿主 shutdown 等待管理和业务清理全部 settle 后才返回失败，不能由一次 OS 清理拒绝提前关闭管理库。
- 新测试还发现并修复 Admin Controller 的取消竞态：发现故障 / 清理期间发生 stop、update 或监督切换时，返回 stopped / observer；另一宿主在原子 claim 前提交停止时同样是取消，不抛启动失败、不创建尝试、不扣修复失败额度。原子 claim 自身发生真实错误时仍保留诊断，不以取消掩盖。
- 本机实际通过 `pmset -g assertions` 核对指定 caffeinate PID 的断言出现 / 释放；强杀其专用 Node 宿主后，确认 helper 实际消失且断言不再存在。Windows/Linux 的 helper 协议及真实 Node 替身时序有检查，但尚无对应 OS 真机证据；不拿这些替身或本机断言等同于 Windows/Linux 验收。

新增 17 项检查，相关路径 **32 项通过**，`/tmp/loopwork-idle-sleep-targeted.log`；最终全量 **957 项通过、0 失败、0 跳过**，`/tmp/loopwork-idle-sleep-final-tests.log`，已核对退出码 0。独立 `tsc --noEmit` 退出码 0，`/tmp/loopwork-idle-sleep-final-tsc.log`；`git diff --check` 通过。隔离 Next 构建退出码 0，仍有两项动态文件追踪警告，`/tmp/loopwork-idle-sleep-next-build.log`。独立实际 esbuild 编译防休眠核心、共享监督宿主和原生适配器，三个输入不含业务库初始化、tasks / interventions / project-settings、Next / Electron 或测试模块。最终桌面运行目录构建退出码 0，`/tmp/loopwork-idle-sleep-desktop-build.log`，待构建终止之后再次检查最终安装树门禁，通过。

主工作区仍只保留 3000 Web 实例，工作台 HTTP 200，不启用业务 Loop，不安装系统服务、不提交 / 推送 / 打 tag。本轮临时 caffeinate 和 Node 进程仅用于受控测试，收尾核对没有本轮 helper 残留；其他工作区已有的防休眠进程不修改。

**全量目标仍在进行**：防休眠接入不等于 OS 托管 / 宿主重启恢复已经完成。阶段 6 的外部托管、准确源码 / 隔离修复构建 / 外部切换 / 启动失败回滚 / 数据库兼容和 ADR 0001，阶段 7 的三条真实模型业务修复闭环及 8–12 小时整夜证据仍缺失。runtime / run / 非 Git 修复能力、可信跨 work item lineage、当前业务诊断、执行中语义停滞、超大故障集合分批验证、历史来源迁移、外部硬等待及自动探测、验证输入归档 / 清理、Windows guardian / Job Object 和 POSIX 逃逸后代的可靠确认仍保留原范围，未判定完成。

## 全部原始故障必须覆盖的独立验收（此前轮次）

- 最终修复验收必须覆盖 Case 的全部业务原始 observation 和非 Admin 的 runtime 原始 observation，不能由修复者选择性提交一部分。仅两种可信派生 runtime 元数据（版本变化、验收覆盖遗漏）和 Admin 自身诊断不作为新的原始复现目标；业务原始记录不能凭同名 kind 排除。独立诊断可以聚焦子集，但不能因此交还 / 关闭 Case。
- status 提供数据库侧 COUNT 和有界 ID 摘录；`hasMore` 明确要求按 history read 分段获取完整历史。错误准确记录实际遗漏数量和有界完整 ID 引用，不截断 ID，也不以展示预算改变必需集合。原始引用容量由 100 提升到 10,000，拒绝重复；大于 100 条故障仍保留完整宿主目标。
- 在提交、独立输入读取、计划授权、收据保存、交还上下文逐层检查完整性。已保存结果 / 准备计划 / 通过收据恢复时同样复核，只有实际物理退出确认后才把旧的部分提交退回原 Case 调查；不改写历史提交、计划、收据或原始故障。旧 observing Case 的部分通过不能启动正常业务交还，保存可信覆盖遗漏元数据并继续原 Case。
- 增加 8 项检查：101 条原始故障、聚焦诊断、迟到故障、旧部分通过收据、旧部分准备计划、恢复提交、旧 observing 交还拒绝，以及派生 / Admin 故障排除。前一轮全量日志 `/tmp/loopwork-original-coverage-final-tests.log` 为 940 项通过、0 失败、0 跳过；最终 Next 构建和桌面安装树门禁已核对。本轮全量回归继续包含这些路径。

完整覆盖门禁不是任意大 Case 的完成证明：10,000 引用 / 目标、计划大小和私有输入树容量仍需分批验收方案，不能通过减少必需原始目标规避超限。此处受控管理 / 业务记录测试不是三条真实模型闭环。

## 原始故障与当前接管锚点分离（此前轮次）

- 原始故障及其 execution 输入 / revision / epoch / 验收快照保留为历史事实，不修改为当前行。业务接管完成时在真实物理退出检查之后，返回当前 task / item / revision / dispatch epoch / 工作区路径的 `anchor`，由可信管理动作持久化。清理进程期间 epoch 改变时拒绝授权，仍保留 draining 屏障。
- 管理请求只按原 Case 的业务工作项身份确认作用范围，不能拿旧 observation 的 revision 当当前授权；实际业务能力必须核对请求 revision 与当前数据库行。请求本身不授予写入权限。跨版本历史不能绑定任意其他需求 / 工作项。
- 独立验收输入和交还都使用同一份已完成接管锚点，核对 action / result 路径和版本一致，拒绝多份不同锚点或缺失锚点。缺少历史锚点不猜测，也不把旧 observation 追认为当前接管；默认验证记录来源失效并回到原 Case 自动调查。
- 同一个工作项不同 revision / epoch 的原始故障可一同保留和独立读取；不再要求历史 epoch 必须等于当前交还 epoch。实际交还仍核对当前 revision / epoch、独立验收代次、修复所有者、实际版本、物理退出和未解决介入，只有创建新的正常 dispatch cycle，没有直接完成 Dev/Test。
- 新增受控业务闭环同时冻结两个实际数据库版本的故障，保留旧输入及验收，以当前 revision 的真实接管锚点交还，再通过原业务命令提交 / apply / completion event 实际推进并关闭 Case。另覆盖缺少锚点和清理期间派发代次变化的拒绝路径。这是受控业务命令 / 物理进程证据，不是三条真实模型业务验收。

新增 3 项检查，相关路径 52 项检查通过；最终全量 **932 项通过、0 失败、0 跳过**，`/tmp/loopwork-current-anchor-final-tests.log`，已核对退出码 0。独立 `tsc --noEmit` 与 `git diff --check` 通过；隔离 Next 构建退出码 0，仍有两项动态追踪警告，`/tmp/loopwork-current-anchor-next-build.log`。实际编译两条独立管理模块的 11 个输入，未包含业务数据库初始化、tasks / interventions / project-settings 或测试源模块。实际桌面运行目录构建退出码 0，`/tmp/loopwork-current-anchor-desktop-build.log`，最终安装树门禁通过。3000 工作台 HTTP 200；未启用主工作区业务 Loop、新增 Web 实例、提交或推送。

**全量目标继续**：当前锚点分离覆盖身份保持不变的工作项跨 revision / epoch；重规划后被替换为另一 work item ID 的可信 lineage 映射还需要专门能力，不能仅凭相同标题 / work key 或一个旧快照授权跨项写入。全部原始故障覆盖、当前业务诊断读取、执行中语义停滞、临时验证输入归档 / 清理、大型事实有界读取、非 Git / runtime / run 恢复、外部硬等待 / 自动探测、明确来源历史迁移、Windows guardian / Job Object、OS 托管 / 防休眠、准确源码 Harness 自修复 / 隔离构建 / 外部切换 / 启动失败回滚 / 数据库兼容及 ADR 0001，以及三条真实模型闭环和 8–12 小时整夜验收仍保留全部范围，未判定完成。

## 交还后持续具备派发条件却未启动的自动恢复（此前轮次）

- 增加可信业务观察适配器，复用真实 `inspectDispatchInDb` 的只读队列，而不是看 ready 显示文本。派发容量、优先级、前置需求、工作项依赖、普通资源、修复所有权和物理退出屏障均继续由现有 Dispatcher 判定，不在管理层另写一套容量规则。
- 对每份已验证交还保存 `repair_business_watches`。只有连续采样时确实可派发的时间累计；槽位 / 资源 / 依赖等待、活跃 execution、暂停、需求结束或来源变化不累计。用户 stop / resume 的 intent revision 改变会清零本次可派发计时。管理宿主重启保留已观察时长，超过两分钟的无采样间隔不记作连续可派发证据。达到 20 分钟是调查升级入口，不是通过或转人工。
- 触发时由可信业务能力在同一事务重新核对真实可派发条件、阻止工作项继续派发、创建 agent-fault 介入及冻结 outbox。晚到暂停拒绝创建；操作中用户停止 / fencing 改变会整笔回滚，不能只停止管理记录却遗留业务状态修改。
- 管理侧在同一事务核对当前独立验收 / 交还代次、持久化观察时长、intent 和原 Case 作用域 / 指纹，再保存新观察并将原 Case queued。不能重新使用旧故障冒充新的停滞事实，也不能改绑 / 新建另一条“第一次修复”。管理观察后才跨库确认 outbox。崩溃留在两库之间时，现有发现入口重放同一条冻结观察，业务派发先被保留的介入阻止，不重复创建循环或重置历史。
- 正常工作通过原业务命令门禁实际 advanced 后，仍由原有 fresh result / execution / completion event / epoch / 物理退出 / 无未解决介入的证明关闭 Case。本轮未添加仲裁完成 Dev/Test 或管理 CLI 自己宣布修复成功的出口。

新增 7 项检查，交还路径 23 项检查全部通过，最终全量 **929 项通过、0 失败、0 跳过**，日志 `/tmp/loopwork-business-watch-final-tests.log`，已核对退出码 0。独立 `tsc --noEmit` 和 `git diff --check` 通过。隔离 Next 构建退出码 0，仍有三项动态追踪警告，日志 `/tmp/loopwork-business-watch-next-build.log`；实际桌面运行目录构建退出码 0，日志 `/tmp/loopwork-business-watch-desktop-build.log`，最终安装树门禁再次通过。实际 esbuild 编译独立交还 / 验收管理模块的 11 个输入，未包含业务数据库初始化、tasks / interventions / project-settings 或测试模块。3000 工作台 HTTP 200；未启用主工作区业务 Loop、新增 Web 实例、提交或推送。

**仍未达成完整目标**：这一观察针对真实可派发但没有启动的工作，不将合法长命令误判为队列停滞；执行中语义无进展仍须和执行观察统一加固，不能让 planned / running 显示本身永久掩盖故障。跨 revision / epoch 的交还锚定、全部原始故障覆盖、临时验证输入归档 / 清理、非 Git / runtime / run 诊断和资源能力、外部硬等待证据 / 自动探测、明确来源的历史人工兜底迁移、Windows guardian / Job Object、OS 托管 / 防休眠、准确源码 Harness 自修复 / 隔离测试构建 / 外部切换 / 启动失败回滚 / 数据库兼容及 ADR 0001、三条真实模型业务闭环和 8–12 小时整夜验收仍保持原范围，未删减。当前受控业务数据库 / Node / Electron 测试不是三条真实模型验收或整夜证据。

## 独立验收输入指纹与失效恢复（此前轮次）

- 准备者实际退出后，对其整个私有输入目录生成清单，而不是从 shell 字符串猜脚本路径。包括冻结事实、计划、脚本、递归导入 / 数据和目录模式；文件内容通过流式 SHA256 读取，不把大型文件读成字符串。拒绝目录替换、根外路径、软 / 硬链接和特殊文件；前后两次完整扫描一致才授权。
- 输入清单与计划在同一个管理库事务中保存，已保存清单不可覆盖。宿主失效后仍复用同一清单；旧记录没有清单时拒绝复用，不把当前脚本追认成原始已执行脚本。
- 默认独立验证在 worker 启动前、每条实际检查前后、收据保存前和最终收尾前复核清单。修改脚本、添加替代数据、脚本自己改写输入、目录被替换或历史清单缺失均不能生成通过 / 交还。输入失效记录在原 Case，确认物理退出后回到 queued 调查，不无限循环同一份失效计划；原始故障、旧计划和旧收据不改写。
- 增加轻量管理代次校验，流式读取期间不再每个块重读 / 解析全部原始契约；完整来源仍在计划授权门禁校验。目录枚举也使用有界迭代，不先一次读入任意大的目录。每份输入最多 10,000 个条目 / 256 MiB，超限明确失败，不截掉输入冒充完整验证；读取带 30 秒取消信号，用户停止和监督失效可取消，尚不能把无法取消的文件系统调用声称为绝对硬超时。
- Prompt 明确生成后的目录只作为验收输入，命令不得向其中写结果 / 缓存；需要输出的检查应使用另外的运行临时目录。原有 20 分钟长命令窗口未缩短。

新增 9 项检查（含流式轻量 fencing 回归），最终全量 **922 项通过、0 失败、0 跳过**，`/tmp/loopwork-frozen-verification-final-tests.log`，已核对退出码 0。独立 `tsc --noEmit` 和 `git diff --check` 通过。隔离 Next 构建退出码 0，仍有三项动态追踪警告，`/tmp/loopwork-frozen-verification-next-build.log`；桌面运行目录构建退出码 0，`/tmp/loopwork-frozen-verification-desktop-build.log`，最终安装树门禁再次通过。实际 esbuild 编译两条独立验证模块的 19 个输入，未包含业务数据库初始化、tasks / interventions / project-settings 或测试模块。3000 工作台 HTTP 200；未启用业务 Loop、新增 Web 实例、提交或推送。

**完整目标仍未完成**：上述清单是检查边界上的软件完整性门禁，不是 OS 只读容器，尚不能证明长命令中短暂修改后恢复不会逃过复核，也不能覆盖命令自行读取的所有外部可变依赖；真实模型生成断言的语义质量仍需真实任务证明。临时输入的历史归档 / 安全清理、大型事实的有界读取、全部现存故障覆盖、跨 revision 交还锚定、业务停滞观察、runtime / run / 非 Git 范围、外部等待 / 自动探测、历史来源迁移、Windows guardian / Job Object、OS 托管 / 防休眠、准确源码 Harness 自修复 / 隔离构建 / 外部切换 / 回滚 / 数据库兼容及 ADR 0001、三条真实模型闭环和 8–12 小时整夜验收仍继续按全量目标实施。本轮受控真实 Node / Electron 检查不代替这些验收。

## 生产默认独立验收准备与原生执行

- 生产组合现在默认安装 `createDefaultRepairVerification`，不再因未注入 `resolveVerificationPlan` 将 verifying 留成无执行入口。已有显式注入的可信计划 / 验证启动适配器仍保留。
- 由独立管理库读取最近已完成的修复 / 诊断提交、其实际已完成接管动作和请求引用的冻结故障。来源绑定包含修复 generation / owner / fencing token、task / item / revision / dispatch epoch 和实际工作区路径，缺少代次不猜测补零。普通业务槽位不参与。
- 首先启动一个单独持久化的 Test 调用，不给 Admin / 业务 execution / Intervention 凭证（包括配置执行器环境内的同类变量）。输入只含原始事实及真实版本，不注入修复者的检查建议。冻结需求说明新增实际 execution 输入和故障时当前行的分开记录，后来的数据库编辑不能替换实际输入。
- 宿主确定原始目标引用：所引用故障的每条冻结 acceptance，以及完整原始契约（包括执行时输入 / 后来当前事实的矛盾）。独立 Test 只能在本次临时目录构造脚本和输出 reproduction / acceptanceChecks JSON；不能填写版本、来源或通过状态。宿主授权完整引用集合，不能遗漏 / 添加替代目标。目标容量扩展到 10,000，超过 100 的冻结验收不会因额外完整契约检查而被截掉。
- 在准备前后读取真实工作区指纹，验证事实文件未改写；CLI exit 0、没有 JSON 输出、遗漏目标、准备者修改业务源码或临时目录越界均不授权计划。目标索引对完整契约采用 JSON pointer，不重复拷贝整块大型契约；完整原始事实仍保留。
- 准备和执行是两个物理 generation，均使用现有 verification role / 独立管理槽位和进程退出屏障。准备结果保存在 `repair_verification_preparations`，先保存计划、再确认物理退出、再收尾；仅准备完成不能交还、推进或关闭 Case。保存后宿主失效，确认原进程退出后恢复准备并进入下一代原生检查，不再调用模型。
- 下一代原生 worker 重跑原始失败、全部计划验收和前后版本检查，保存实际退出码 / 原始输出 / 进程组退出证明。收据成功也只进入 observing，仍要求可信交还和普通业务实际推进；没有仲裁完成 Dev/Test 的新出口。
- 生产默认路径增加实际业务工作区只读门禁，检查暂停 / 结束、revision / epoch / 路径、原修复资源代次、冲突物理屏障 / 普通资源及其他介入 / 人工输入。运行中每秒异步复核，单次查询限 5 秒，复核不重叠且不排入续租队列；失效取消实际调用。收尾等待已开始的复核，不允许迟到检查越过结果收尾。
- 来源失效保存为原 Case 的证据，保留旧计划 / 收据，撤销当前验收和交还权限，物理进程退出后回到 queued 调查。特别覆盖“通过收据刚保存、所有权随后失效”：不能用该旧收据推进，也不能遗留一条已退出但永远 running 的管理记录。
- 桌面主进程没有服务器子进程继承的 `ELECTRON_RUN_AS_NODE` 标记；原生 worker 和管理 / 独立 Test 子环境现在按桌面 Node 入口启用该标记，不全局修改 GUI 主进程环境。实际本机 Electron 可执行文件以 Node 模式完成独立检查，未开启第二个应用窗口。

本轮 15 项新增检查纳入最终全量回归：**913 项通过、0 失败、0 跳过**，日志 `/tmp/loopwork-default-independent-verification-full-tests.log`，已核对进程退出码 0。独立 `tsc --noEmit` 与 `git diff --check` 通过；默认 Next 构建退出码 0，仍有三项动态追踪警告，日志 `/tmp/loopwork-default-independent-verification-next-build.log`。实际桌面运行目录构建退出码 0，日志 `/tmp/loopwork-default-independent-verification-desktop-build.log`，随后最终安装树门禁再次通过。实际编译两个独立验证模块的 metafile 未包含业务数据库初始化、tasks / interventions / project-settings、Next / Electron 或测试依赖。

另外用本机真实 Electron Node 进程加载该桌面目录的 `lifecycle-host.cjs`，在 `/tmp/loopwork-packaged-host-smoke.pSRUmI` 的独立数据 / 工作区初始化全部迁移并重新读取管理库，确认 intent=stopped、admin attempts=0，宿主正常退出。第一次该验证因未初始化测试 PID 被数据库隔离门禁拒绝；补齐本任务隔离 PID / 数据路径后通过，未关闭隔离保护。3000 工作台 HTTP 200。没有启用主工作区业务 Loop、新增 Web 实例、提交或推送代码。

**不能称完整目标完成**：这些是可控真实 Node / Electron 进程测试，不是三条真实模型业务闭环。独立模型生成断言的语义质量仍须用真实任务验证；生成的临时验收脚本的完整性 / 清理、大型事实文件的有界读取、全部现存故障覆盖与跨 revision 交还锚定，以及普通业务停滞观察仍需加固。默认工作区验收目前只接受真实已接管业务工作区，其他 runtime / run / 非 Git 范围仍需对应诊断和资源能力，不能虚构通过。真正外部等待 / 自动探测、历史来源迁移、Windows Job Object / guardian、OS 托管 / 防休眠、准确源码 Harness 自修复 / 构建 / 外部切换 / 回滚 / 数据库兼容、ADR 0001、三条真实模型闭环和 8–12 小时证据仍属完整目标，未删减或判定完成。

## 真实工作区版本与交还后版本变化恢复（此前轮次）

- 新增 `readRepairWorkspaceVersion`，使用异步 Git 调用与最多 16 个并行文件流，读取真实 HEAD、全部 tracked 源文件内容、未被忽略的 untracked 内容及常见 `.env` 配置。`assume-unchanged` 不能隐藏源码变化；不运行 git add / write-tree，不改用户 index。文件名通过 NUL 分隔，路径不能越过工作区；只输出内容指纹，不输出配置秘密。
- 路径集合、文件内容和 HEAD 前后重复校验，并检查读取期间的 inode / mode / mtime / size。工作区版本格式为 `workspace-content-v1:HEAD:SHA256`；原始文件和配置未提交变化也会改变版本。未跟踪的 `.tmp` 测试临时文件不影响版本，已跟踪 `.tmp` 文件仍纳入。
- 默认 30 秒读取边界，用户停止 / 监督代次变化通过注入的当前所有权校验取消进行中的 Git 调用和文件流。Git 仓库无有效 HEAD、源文件不可读、路径逃逸或源码持续变化时明确失败，不能回退为虚构版本。Git submodule / 目录源树仍需要额外版本能力，尚未支持其完整递归内容。
- `workspace-version` 作为独立只读入口纳入打包；实际编译 CJS 的安装目录入口与宿主读取同一工作区时产生相同指纹，入口不加载管理 / 业务数据库或 Web 实现。Admin Prompt 提供 POSIX / PowerShell 引用方式，要求完整版本串用于 repairVersion / baselineVersion，不接受以 echo 替代真实版本。
- 生产默认工作项交还启用真实工作区版本读取与业务推进观察，不再仅因没有注入 readVerificationVersion 而停用 followup。独立验证计划仍需要可信来源；本轮没有将修复者自己的建议命令升级为验收权威。
- 交还门禁的实际版本不一致形成 `RepairHandoffVersionChanged` 类型事实。管理模块核对当前独立验证来源，记录新版本事实并重新打开原 Case 为 queued；不只记日志停留在 observing。原始故障、验收、失败预算、已保存验证收据和工作区屏障保留，业务事项仍 waiting / pending，下一轮接管继续同 Case。不递归创建新 Admin，也不直接完成 Dev/Test。

该轮新增 10 项版本 / 原生进程 / 交还恢复检查，与已有真实普通命令推进测试一同回归；随后添加三项产物门禁测试，全量达到 **893 项通过、0 失败**，日志 `/tmp/loopwork-workspace-version-full-tests.log`。这些是可控物理 CLI / 文件测试，不是三个真实模型修复闭环。实际产物和后续版本读取缺陷的最终验证见下节。

**完整目标仍在进行**：生产默认独立验收计划尚未实现，故障 verifying 不能据此称默认无人值守闭环；工作区指纹也不证明正在运行的服务器使用了该版本，旧服务问题仍需独立端点 / 服务版本检查。普通业务停滞观察、跨 revision 的验证 / 交还来源锚定、其他范围和非 Git 工作区版本能力、数据库侧有界历史读取、真正的外部等待 / 自动探测、历史来源迁移、Windows Job Object / guardian、OS 托管与防休眠、准确源码自修复 / 隔离构建 / 外部切换 / 回滚 / 数据库兼容、ADR 0001、三条真实模型闭环与 8–12 小时整夜证据均未删除或判定完成。

## 按需调查历史、实际桌面产物与目录链接版本校验

- 状态和 Prompt 的五类历史改为数据库计数及 `LIMIT 1 OFFSET` 按需读取；摘要消费到展示预算即停止。历史分段只查询指定索引，不先物化整份集合。命令认证和接管校验也直接查询当前 attempt，不扫描该 Case 的所有尝试。
- 五类历史的排序和返回结构保持一致；诊断收据只在对应行确实被展示或读取时加载。读操作使用同一 SQLite 快照，原始记录未删改；新增按 Case / 时间排序索引。两个新增测试覆盖懒加载截止、禁止旧整批加载器、读取最后一条完整证据、哈希拼接及停止失效。
- 这仍不是无限大小单行的流式读取：当前按条读取后计算完整 JSON / 哈希，单条巨大记录仍可能有同步 CPU / 内存压力。status 的 actions / submission 等非历史字段仍须补齐硬预算；完整目标中的管理续租可靠性不能仅由本轮摘要测试宣称达成。
- 实际检查隔离 Next standalone 发现九个 `src/test` 文件，原来的 esbuild 依赖门禁未覆盖这类非模块导入的文件追踪。增加全局追踪排除，并在替换旧桌面运行目录之前、以及复制和编译完成之后，检查实际安装树并拒绝测试源文件污染。为避免旧文件伪装成新的追踪结果，首次验证先将本任务独立缓存的 `.next` 移到 `/tmp/loopwork-next-trace-quarantine.BRg2vC/.next`，再重建；没有清理用户服务缓存或删除旧产物。
- 新的 route NFT 清单已无测试文件，instrumentation NFT 清单仍包含九个测试路径；不能称所有 NFT 元数据已经干净。实际 standalone 和最终桌面安装树均须通过独立文件门禁，不能以编译入口检查替代整份产物检查。
- 真正运行打包后的 `workspace-version.cjs` 时发现本仓库 `.claude/skills -> ../.ai/skills` 目录链接导致读取失败。现在递归纳入根内目录链接的全部内容和目录 / 链接元数据，包括引用树中被 Git 忽略的文件；前后复核目录集合和完整指纹。越界或循环链接拒绝读取，不将目录伪造为空文件。三个新增测试覆盖实际技能目录链接、忽略配置变化、循环 / 越界链接和继续拒绝未支持的 Git submodule 目录。

最新全量回归 **898 项通过、0 失败、0 跳过**，日志 `/tmp/loopwork-admin-bounded-history-full-tests.log`，已核对进程退出码 0。独立 `tsc --noEmit` 与 `git diff --check` 通过；默认 Next 构建退出码 0，仍有两项动态文件追踪警告，日志 `/tmp/loopwork-admin-bounded-history-next-build.log`。真实桌面运行目录构建退出码 0，日志 `/tmp/loopwork-admin-bounded-history-desktop-build.log`；随后再次检查最终安装树，并用该安装树的 CJS 入口与源码读取器分别读取当前真实 LoopWork 工作区，指纹完全一致，均退出码 0。3000 工作台 HTTP 200。整个过程未启用业务 Loop、新增 Web 实例、提交或推送代码。

**下一条主链必须完成**：从被冻结的原始契约生成生产默认独立验收，而不是信任修复者提议的检查命令；之后仍需实际版本 / 服务入口验证、交还后业务停滞恢复。阶段 6 的宿主 / Harness 自修复和阶段 7 的三条真实模型闭环 / 8–12 小时证据仍未完成。

## 原始验收快照与有界调查上下文（此前轮次）

- Agent 故障 outbox 在业务阻塞事务内冻结原始契约、验收、验证 YAML 场景 / 结果及命令收据；跨库重放不重新读取或改写快照。事务回滚时快照和业务阻塞一起消失。
- 实际执行输入的 `contextSnapshot.authoritativeFacts.currentDeliverySpec` 保留为 `authoritativeExecutionSpec`。按实际 task / unit / revision 读取关联行，缺失旧 revision 不回退成新的 resolved 契约。同 revision 的数据库行也不证明内容未变化，不能替换实际执行输入。
- 故障时当前行标明 `fault-time-current`，缺少输入绑定或旧引用时保留不一致证据，不伪造已使用的版本。其他交付单元的验收不混入；命令收据同时匹配 source execution / key / task / unit / test Agent / tool_event，来源匹配不代表验收通过。
- Admin Prompt 自动注入历史使用分区展示预算，并有 60,000 字符总上限；较大原始记录和未显示历史带有读取位置与截断标记。status 对五类历史采用相同摘录，不清理管理库中的完整数据。恢复决策只自动展示最近 16 个失败执行 ID，实际失败历史和决策记录保留。
- 增加只读 `history read --collection observations/evidence/attempts/followups/diagnoses --index N --start N --length N`。每次最多读取 8,000 字符，先 status、当前 Case / attempt / intent / supervisor 凭证校验保持不变；不能传其他 task 或 Case。后续段可传 `--hash`，内容变化则拒绝混拼并要求从头读取。
- 大记录在管理数据库重启后逐段拼接仍与原始序列化内容完全一致；读取证据不推进工作项、完成验证或关闭 Case。

最新全量回归 **880 项通过、0 失败**，日志 `/tmp/loopwork-original-contract-history-full-tests.log`，已确认进程退出码 0。独立 `tsc --noEmit` 与 `git diff --check` 通过。隔离默认 Next 生产构建退出码 0，日志 `/tmp/loopwork-original-contract-history-next-build.log`；构建仍有 3 项已有动态文件追踪警告，不能称零警告。3000 工作台 HTTP 200，未新增实例、启用业务 Loop、提交或推送代码。

**仍未完成**：冻结事实不等于可执行独立验收计划。生产默认 `resolveVerificationPlan` / 版本读取与交还仍需补齐，不能据此宣称 verifying 已默认自动闭环。历史摘录当前先读取集合再限制输出，还需要数据库侧有界查询以避免超大 Case 的同步读取压力；status 的非历史字段也尚无整个响应的硬预算。普通业务停滞接入、原始目标驱动的独立检查、其他故障范围交还、历史来源迁移、外部硬故障自动探测、Windows 可靠进程容器、OS 托管 / 防休眠、准确源码自修复 / 构建 / 外部切换 / 回滚与数据库兼容、ADR 0001、三个真实模型修复闭环及 8–12 小时整夜证据均仍属于原目标，未缩减或判定完成。

## 阶段 1 当前进度

已修改：

- 超时 / 取消不再等待终止日志写入，拒绝写入不会阻断杀进程。
- 在异步进程身份登记前监听完成事件、读取 stdout/stderr，避免短命 CLI 信号退出漏观察和最后诊断丢失。
- 完成观察使用 close，保留管道末尾输出；终止中的清理完成后才进入受管进程收尾。
- POSIX 清理对捕获的整个树验证退出；根退出而后代拒绝 SIGTERM 时继续升级 SIGKILL；再次发送信号前校验进程身份。
- 存活进程身份查询失败是未知状态，不是退出证明；无权限不能算已退出。

定向验收：47 项测试通过，覆盖三个超时入口的日志拒绝、身份登记期间信号退出、重复取消、子进程残留，以及已有停止来源 / 迟到失败 / 结果恢复契约。

本轮全量回归：734 项测试通过；独立 `tsc --noEmit` 与 `git diff --check` 通过。
全量测试输出：`/tmp/loopwork-admin-stage1-tests.log`。这些证据仅对应当前本机实现，不等同于 Admin 闭环或整夜验收。

仍待完成：

- 根失联且原适配器没有留下整个进程树退出证明时，自动确认遗留后代的退出；当前保守保留屏障，不能用根消失或 PID 复用替代证明。
- 进程身份登记前的宿主崩溃窗口，以及真实跨宿主 / Runner 终止的完整故障注入验收。
- 将上述未知状态交给后续独立 Admin 诊断，而不是使普通业务执行冲撞资源。

## 持久化退出屏障进度

- 新增迁移 122：`execution_processes` 保存实际调用分配与 PID / 身份，`execution_process_barriers` 保存物理资源屏障；逻辑取消和 claim 清理不会删除屏障。
- 在 spawn 前原子建立屏障，spawn 后同步绑定 PID，并校验 execution / run / task 来源；避免启动前取消和同源重复调用。
- 调度计算和实际资源获取同时检查物理屏障；即使逻辑 claim 已被删除，也不会派发同项目冲突执行。
- Work Item 和系统介入调用均显式传入 executionId；同一 execution 的正常续跑在前一调用实际退出后才重新启动。
- 适配器只在成功确认后释放屏障；根 close 但整个树未确认时拒绝执行成功收尾，保留状态与诊断。
- 宿主可独立清理执行进程；用户停止与监督代次切换接入同一数据源；未知 PID 和未知启动窗口不误杀、不默默解锁。
- 某个进程退出不确定不阻断其他已知 CLI / Runner 的停止尝试；处理全部目标后报告残留。
- 历史项目数据库合并不导入其他宿主的物理进程与屏障，避免将运行所有权当成业务历史复制；原始数据保持不变。
- 新增 9 项契约 / 真实进程测试：暂停立即恢复、重复 launch、错误来源、数据库重连、项目隔离、宿主清理失败重试、未知启动、PID 复用 / 查询异常、根 close 未确认、停止继续处理其他进程。

本轮定向测试与 Runner 回归共 22 项通过，独立类型检查通过。
随后宿主 / 历史合并定向回归共 20 项通过；全量回归已达到 743 项通过。
最终全量测试输出为 `/tmp/loopwork-exit-barriers-full-tests.log`；以该文件终态汇总为准。

## 独立进程组与阶段 2 结构迁移进度

- 迁移 123 保存 POSIX 独立进程组身份；业务 CLI 正常退出后仍确认整个进程组退出，避免根进程消失但后台后代继续写代码。真实进程测试覆盖根被终止、后代拒绝 SIGTERM，以及正常 CLI 留下后代的清理。
- Windows 仍使用身份校验后的进程树清理；根失联和登记前宿主崩溃窗口尚需可靠启动接管协议，不能宣称该路径已完成。
- `loop-runs.ts` 与 `loop-run-log.ts` 已从 `tasks.ts` 移出；旧调用通过兼容导出继续工作，Lifecycle 与基础 Runner 操作已切换新模块。
- Lifecycle 可注入数据库、时钟、进程、Run 操作与事件 Hub。监督续租独立于串行清理队列；定时 reconcile 合并排队，避免清理重叠。
- 注入时钟的契约测试证明初次清理阻塞 40 秒时仍逐次续租，不增加监督代次、不重复清理，关闭时释放计时器、Hub 与租约。
- `execution-invocation.ts` 提取同一 execution 的 CLI 调用与正常退出续跑协调，可不启动完整 Runner 单独测试；保留已有持久化提交优先、诊断累积、取消和证据失败语义。
- 新增 5 项独立协调测试：连续调用诊断、非零退出已有提交、取消续跑、证据失败不续跑、启动与准备失败记录。

结构迁移前一轮全量 747 项通过，输出 `/tmp/loopwork-lifecycle-extraction-full-tests.log`，独立类型检查通过。
最新协调提取后的全量测试以 `/tmp/loopwork-invocation-extraction-full-tests.log` 终态为准。
已检查该文件最终汇总：752 项通过、0 失败；最新独立 `tsc --noEmit` 与 `git diff --check` 通过。
旧 Runner 静态续跑检查已改为检查协调入口与资源释放顺序，实际续跑行为由独立协调测试验证。

本阶段首次提取时，结果应用、失败策略、恢复与收尾尚未迁出；后续迁移与依赖约束证据见下节。
阶段 3–7 尚未实现；前半段通过也不能宣称具有 Harness 自身故障下的全自动恢复能力。

## 单次 Execution 协调迁移与依赖边界

- `execution-coordinator.ts` 现在拥有 reservation 启动校验、activation、单次调用协调、持久化输出、结果应用、失败策略调用与 settlement；Runner 只调用 execute / recover。
- `delegation-prompt.ts` 拥有恢复包构造；`evolution-execution.ts` 拥有后台总结执行及其现有恢复策略。具体 CLI / 超时 / 终止提交 / 结果契约错误类别不再由 Runner 判断。
- 新增独立数据库契约测试：保存结果后恢复无需重建 prompt 或重启 CLI、重复恢复不重复应用；暂停后保存结果作为 discarded 证据收尾，不产生文档副作用、不新增重试扣减。这里 applied 是结果处理已收尾，不能等同于暂停任务业务完成。
- 从 application 移出所有 Next 缓存导入，改由 Web instrumentation 安装页面失效适配器；CLI 无适配器也可运行，缓存异常不能破坏持久化操作。
- 实际 esbuild 生产入口测试同时检查转依赖和 external imports：四个运行入口均不加载 Next/Electron，不含历史测试调度器；实际执行编译后的 CLI 和 Lifecycle 入口成功。
- 新增 Runner 边界检查，禁止具体失败类别与恢复选择函数重新进入 Runner。

本轮最终全量回归 757 项通过、0 失败，输出 `/tmp/loopwork-execution-coordinator-full-tests.log`；含新增边界检查的定向 17 项通过。独立 TypeScript 检查通过。
本机 3000 工作台响应 HTTP 200，Next dev 已生成 instrumentation 注册实现；该检查仅证明本机入口加载，不替代管理闭环验收。
当前源码在 `/tmp/loopwork-admin-stage2-build.p7Pfmv` 隔离构建成功（默认 Turbopack、生产类型检查、页面生成与 standalone 跟踪），日志 `/tmp/loopwork-admin-stage2-next-build.log`，构建进程退出码 0。没有停止或新增 Web 服务，也未修改 3000 实例的构建目录。
第一次隔离构建因跨文件系统根的 node_modules 符号链接被 Turbopack 拒绝；改为独立依赖副本后原默认构建成功，没有切换到另一构建器掩盖问题。

接下来建立独立 Admin Controller / RepairCase。进程根失联和启动登记窗口的完整修复、管理执行、原始失败独立验证、恢复策略升级、宿主自修复与整夜验收仍未完成。

## 阶段 3：管理存储与 Controller 基础

- 新增 `AdminManagementStore`：显式独立绝对路径、独立 WAL SQLite，不初始化或迁移业务 / 应用数据库，也不需要 task/run 外键。路径别名、既有业务表和其他用途的数据库不会被误接管；高于支持版本的管理库拒绝降级写入。
- RepairCase 按范围、范围标识与失败指纹合并；原始版本、摘要、观察和修复证据保留。观察与意图命令幂等；相同标识的内容不能被改写。
- 独立管理监督租约和递增 fencing token；修复尝试有独立接管代次与物理进程身份。租约过期不清除旧物理调用；只有实际退出证明能释放。迟到结果与证据不能使用旧所有权写入。
- Controller 不读取业务 ready 队列或全局普通 Agent 并发限制。独立定时续租不排在慢启动 / 清理后面；用户停止先持久化意图并立即取消待启动调用，再进行清理。
- Admin 失败继续原 Case，不创建“Admin 的 Admin”；管理基础层不会因尝试次数转人工。完整的换策略与有效进展检测仍属于后续恢复策略实施。
- 不确定退出不会丢弃可用于停止的 handle；后续继续清理，确认后才恢复下一调用，保留首次错误。
- Admin 修复总结只能请求验证，把 Case 留在 verifying，不能直接关闭 Case 或把 Dev/Test 标记完成。

定向 13 项通过，覆盖数据库重开、双连接接管、旧代次拒绝、重复意图、不可改写证据、慢启动续租与即时取消、真实 Node CLI 在普通槽位 / 代码资源满时启动且不改业务记录、损坏业务库情况下管理继续，以及实际编译后的无业务 / Web 依赖管理库运行。
前一轮全量 769 项通过；最新安全校验后的结果以 `/tmp/loopwork-admin-management-full-tests.log` 最终汇总为准。
已核对最新终态：770 项通过、0 失败；独立 `tsc --noEmit` 与 `git diff --check` 通过。修复观察另保存完整快照，Admin 自身故障的独立指纹不会仅留作不可逆摘要；错误回调异常不会阻断监督和清理。

**阶段 3 当前状态**：Controller、故障发现桥接和 Intervention 关联已接入生产 Web / Electron 宿主，详见下方生产接线证据。新产生的 agent-fault 从源头归独立 Admin，旧调度器不能抢先领取；自动直接完成 Dev/Test 已禁止。普通辅助请求及有确切故障证据的历史兜底迁移、完整恢复策略和独立验证仍未完成，不能据此宣称生产已经无人值守自动修复。

## 共享宿主协议与独立 Runtime 配置

- `runtime-supervision-host.ts` 为桌面 / 独立宿主提供同一初始化与运行意图协议：管理计时器先安装，管理调用与业务初始化并行；慢管理启动不会阻塞无关业务，业务数据库失败不会终止管理监督。
- 业务适配器必须先持久化传入的管理意图，再启用业务监督；初始化期间到达的停止会重新读取最新意图，不重放旧 running 快照。用户停止先写独立管理库，再并行启动两侧取消，旧 start 幂等请求不能覆盖新 stop。
- 业务库不可用后，宿主健康计时器自动重试业务初始化，不重复创建管理 Controller；关闭宿主保留运行意图、取消计时器，并合并重复关闭调用。
- 管理库单独保存已配置执行器 / 模型 / 推理选项及来源版本，配置写入校验当前监督权和乐观 revision，迟到刷新不得覆盖新配置。不接受环境、密钥或普通 execution 权限字段。
- `admin-configured-execution.ts` 在调用前刷新配置，业务配置读取失败时复用持久化的精确配置，不擅自换成默认执行器。每轮留下所选配置及缓存来源证据；异步配置读取期间停止会阻止 spawn。没有任何已配置快照时保留可诊断失败，不虚构可用 Runtime。
- 配置解析的失败有“尚未启动子进程”的确定证明；下游实际 launch 拒绝则仍由物理适配器 / Controller 判断，不能把未知启动当作退出。

本轮新增 8 项行为测试全部通过，另新增实际编译并执行共享宿主 / 配置协调入口的依赖边界检查。真实独立 Controller 与不可用业务存储的组合测试通过。
最新全量回归终态为 801 项通过、0 失败，输出 `/tmp/loopwork-admin-host-protocol-full-tests.log`；独立 `tsc --noEmit` 通过。3000 工作台响应 HTTP 200，没有新增实例或启用业务 Loop。
这一轮基础协议完成时尚未替换 Web / Electron 入口；随后生产接线见下节。独立验证和资源交还仍未完成；不可把该段证据视为阶段 3–7 完成。

## 生产宿主接线与更新安全

- `runtime-supervision.ts` 作为生产组合入口，把独立 Store / Controller、配置缓存、业务 outbox、管理接管能力和业务 Lifecycle 组合起来。Web 的启动 instrumentation、实际生命周期 API，以及 Electron 的打包宿主均使用同一实现；管理调度仍不占普通 execution 或 Agent 槽位。
- 升级初次读取旧业务运行意图只在管理 revision=0 时迁移一次；任何并发用户停止都会阻止旧业务 running 快照覆盖它。Lifecycle 在监督和 Runner 启动前同步独立意图，并在异步清理和 beginRun 后再次校验停止 / 暂停。
- 管理库保存更新静默状态，和用户停止分开：静默保留 desired_intent，立即使旧命令凭证失效、取消管理调用。更新前无法证明全部管理进程已退出，则拒绝准备与就绪；恢复后不会撤销静默期间的用户停止。
- 非所有者的 UI 宿主也能在用户停止 / 更新时立即清理持久化的已知管理进程，不等待所有者下一个 10 秒 tick；记录退役仍受原监督 fencing 约束，不能借停止抢夺修复所有权。
- 管理错误日志落在独立 admin/host.log；业务初始化、配置或 outbox 读取失败记录独立 runtime RepairCase，保留安全脱敏的异常、版本和宿主路径。业务库无法打开时已有管理调查仍能继续。

本轮新增 6 项测试通过：生产意图迁移 / 重启、初始化期间停止、真实独立 CLI 与原始 outbox / 人工记录、管理更新退出门禁、真实跨宿主停止，以及实际编译后两份数据库均损坏但缓存模型的独立管理调用仍能启动和退出。损坏数据库的原始内容保持不变；这不是修复损坏数据库或三个真实模型闭环的证明。
全量最终 807 项通过、0 失败，日志 `/tmp/loopwork-admin-production-host-full-tests.log`；独立 `tsc --noEmit` 与 `git diff --check` 通过。隔离默认生产构建成功，日志 `/tmp/loopwork-admin-production-host-next-build.log`，进程退出码 0。
本机真实 3000 生命周期 API 返回 HTTP 200；已重新读取 `data/admin-management.db`，独立管理 owner 是该 Web 进程，desired_intent=stopped、management_mode=normal、物理管理 attempts=0。没有启动业务 Loop，没有新增 Web 实例或修改服务构建缓存。

上述生产接线完成时仍有旧仲裁交接窗口和自动完成出口；随后修正见下节。当前仍须实现独立验证 / 版本证明 / 资源交还 / 后续业务推进观察，统一策略升级和外部探测，转换有明确 Agent 故障证据的历史人工兜底记录并保留真实人工来源，以及后续 OS 托管 / guardian / Harness 自修复与真实模型整夜验收。管理 Case 的 UI 状态与调查执行展示也不能继续使用旧普通介入的三次额度作为实际状态。

## 故障归属收敛与自动完成出口关闭

- 普通 `claimNextIntervention` 在 RepairCase 异步关联前就排除 source_kind=agent-fault；原始故障和 outbox 同事务落盘后，只有独立管理调度能启动排障。不会用正常 Agent 并发额度或旧 max_system_attempts 阻止新故障修复。
- 旧 session 一旦已被识别为 Agent 故障，即使 repair_case_id 仍为空，也不能通过旧命令查看并修改运行状态；迟到的旧失败保留历史，转回独立 Admin，不能在第三次失败时进入 awaiting_human。
- 所有自动系统仲裁（包括来源仍未知的历史记录）不能调用 work-item-complete。普通系统提示词和状态协议不再宣传该能力；门禁在实际命令处理内校验，不只是依赖 prompt。
- 人工操作仍通过显式 human_only / human-input 来源和独立可信入口执行，保留原始验收、失败、处置理由及 actor=human 审计。它们不需要先让 Agent 失败三次，也不会被转换为 Agent 故障；未知历史输入未被盲目自动接管。
- 已将原先以“Agent 三次失败转人工”为前提的人工裁决测试迁到明确人工来源，继续检验原生 / 兼容图边界、跨需求拒绝、回退幂等、冻结事实、事务回滚和其他资源所有者保护。新增故障测试则检验不自动完成、不走旧仲裁，以及同一 RepairCase 持续保存五轮管理尝试。

本轮新增 3 项历史 session / 迟到失败契约通过；首次全量回归定位了 11 项仍依赖旧转人工前提的测试，迁到明确人工来源后重新验证，未放宽自动完成门禁。最终全量 810 项通过、0 失败，日志 `/tmp/loopwork-admin-fault-ownership-full-tests.log`；独立类型检查通过。
最后仅调整旧调查角色说明和人工 status 的命令列表后，相关 27 项定向回归通过；最新隔离默认生产构建通过，日志 `/tmp/loopwork-admin-fault-ownership-next-build.log`，进程退出码 0。3000 工作台仍响应 HTTP 200，服务实例和停止意图未改动。
这不是完整自动修复闭环：当前 Agent 修复提交仍停在 verifying，独立 Test 验证、版本确认、资源交还与业务恢复观察尚待实现。普通 assistance-request 的固定次数人工兜底和可确定为 Agent 故障的历史记录仍需要按事实升级到管理恢复，不得将当前 source_kind 门禁误解为全系统已消除故障转人工。

## 独立验证执行基础（尚未接入生产调度）

- 管理尝试持久化区分 investigation / verification。验证分配有独立 attempt、接管代次和物理进程身份；修复进程及后代未确认退出时不能分配验证，宿主重启不移除验证的物理所有权。
- 验证执行不能签发修复命令凭证，不能以 verification-requested 总结充当通过证据。被中断的验证在确认退出后回到 verifying，保留原始失败及已保存证据，不自动重跑修复或关闭 Case。
- 独立执行器接收宿主基于原始契约确认的计划，顺序执行修复版本检查、原始失败复现、相关验收和再次版本检查。任一失败、取消、后代退出未知、证据落盘失败或版本变化均不能通过；每条实际执行结果单独落盘。
- 定向测试使用真实 Node 子进程执行复现和验收，并覆盖旧版本 / 版本变化 / 验收失败 / 退出未知 / 证据失败 / 停止 / 重复目标 / 管理库重启及修复凭证隔离。

本节只建立执行基础，不是完整验证门禁：仍须由生产宿主读取原始契约并构造可信计划，接入独立物理执行适配器、持久化最终验证收据及重启恢复，然后实现版本和资源交还、正常业务重执行与实际推进观察。不能直接信任修复者提出的命令，也不能用退出码 0 的任意命令替代原始验收。当前生产 Case 仍停在 verifying。

本轮定向 18 项通过；重新运行全量最终 814 项通过、0 失败，日志 `/tmp/loopwork-independent-verification-full-tests.log`，测试进程退出码 0。独立 `tsc --noEmit`、`git diff --check` 通过，3000 工作台 HTTP 200。没有提交、打 tag、推送或启用业务 Loop。本轮没有重新执行生产构建，前一轮构建结果不作为本轮新代码的构建证明。

## 独立验证收据与 Controller 恢复接线

- 验证计划和最终收据存入独立管理库 repair_verifications，绑定最近已完成的 investigation attempt、修复版本和原始观察 ID。实际验证计划由宿主授权，不复制修复者提出的任意命令；授权后不可改写。
- 最终收据校验每条计划步骤及版本证据，并逐条对应本轮不可改写的 verification-check 证据。缺少、调换或伪造步骤，以及“退出码 0”总结不能通过；对象字段顺序差异不会丢弃真实证据。
- Controller 提供独立 launchVerification 入口，在验证配置存在时分配独立验证，不再重新启动修复者；完成仅在真实退出已确认且最终收据成立时进入 observing。不会完成业务工作项，也不会关闭 Case。
- 宿主崩溃后的已保存验证结果优先恢复，物理退出未知时继续保留分配。失败回到同一 Case 的自动修复队列，原始失败和验证记录保留；停止意图阻止迟到结果应用。

本轮新增 7 项收据 / 来源 / Controller / 重启 / 停止契约，全量最终 821 项通过、0 失败，日志 `/tmp/loopwork-verification-recovery-full-tests.log`，测试进程退出码 0。独立 `tsc --noEmit`、`git diff --check` 通过；隔离默认生产构建通过，日志 `/tmp/loopwork-verification-recovery-next-build.log`，构建进程退出码 0。

**生产闭环仍未完成**：生产组合仅提供可注入验证入口，没有默认启用可信原始验收计划构造和独立物理验证适配器，当前实际 Case 仍可能停在 verifying。进入 observing 也仅表示待交还 / 观察；尚无正常工作项恢复、资源交还、真实业务推进证明及 Case 关闭。测试的受控验证执行不是三条真实模型闭环或整夜无人值守证据。阶段 5–7 仍按完整目标继续，不以本轮收据契约代替最终验收。

## 真实受管验证 worker（本机 POSIX 路径）

- 新增独立原生 worker 和宿主执行适配器。一轮验证使用一个持久化 attempt / PID / startMarker / process group，不把每条 shell 检查作为无主进程启动；不使用普通业务 Agent 槽位。
- 宿主在发送命令前保存授权计划与启动证据，在命令完成后核对同一受管进程组。开发态 tsx / esbuild 辅助进程在第一条命令前记录身份基线；命令新增的进程不能被当成基线，整轮收尾清理整个组（包括辅助进程）后才能应用验证结果。
- 命令默认超时 20 分钟，停止 / 超时 / 进程退出 / IPC 故障均进入实际清理；stdout / stderr 通过 IPC 保留，超时前的诊断尾部也能记录。诊断写入失效或监督权过期不能阻止物理终止。
- worker 不打开管理 / 业务库，不继承修复或业务命令凭证；修复者的命令提案不作为授权。打包新增 verification-worker.cjs，边界测试覆盖实际六个入口，另用隔离 installed 路径执行编译后的原生 worker。
- 生产组合新增 resolveVerificationPlan 能力注入：可信计划能力存在时即可使用原生验证；缺少该能力时不擅自信任修复提案。

**仍有明确缺口**：默认生产宿主尚未构造原始契约 / 原始失败 / 实际服务版本的可信计划，资源交还和业务推进观察未实现。Windows 尚缺 Job Object / guardian 的完整后代退出证明，原生适配器不会把无法证明的退出标为通过；POSIX 进程组也不是对主动逃逸进程组的 OS 级容器，后续宿主托管 / containment 仍须验收。当前测试只证明本机受控同组进程路径，不是跨平台完整关闭证明、三条真实模型闭环或整夜证据。

本轮新增 7 项真实 native worker 契约。第一次实跑定位了开发态 esbuild service 属于 worker 启动基线的问题；保存启动前身份基线并仍检查命令新增成员后，重新运行全量最终 828 项通过、0 失败，日志 `/tmp/loopwork-native-verification-full-tests.log`，测试进程退出码 0。独立 `tsc --noEmit`、`git diff --check` 通过；最新隔离默认生产构建通过，日志 `/tmp/loopwork-native-verification-next-build.log`，构建退出码 0。3000 工作台 HTTP 200，没有启用业务 Loop、提交或推送代码。

## 验证后资源交还与普通业务推进观察

- 交还授权来自独立管理库的当前 observing Case、最近独立验证收据以及已结束的修复 / 验证尝试，不来自 Agent 参数。可信原始业务观察绑定 task / item / revision，不能合并不同工作项；原资源所有权需匹配实际修复来源代次及其所有者，而不是借新宿主 fencing 夺取其他 Case 的资源。
- 业务交还用例异步复核实际版本，在一个业务事务内只解决当前 Case 的 Agent 故障阻塞、resume 原生工作项、记录验证后的新 dispatch cycle 并释放对应修复资源。不直接完成 Dev/Test，不改写原失败、旧 execution 额度或验收事实。真实人工输入、其他介入、未完成依赖、路径 / revision 改变、物理未退出均拒绝交还。
- 接管时发现的物理清理目标在实际终止之前另外保存不可改写收据；普通 barrier 消失后，后续代次 / 交还仍能找到这些原进程，不能仅凭逻辑取消认定安全。接管请求和物理目标收据各自幂等。
- 中途停止 / fencing 变化通过事务末复核回滚整个交还，包括介入解决、resume、dispatch cycle 和资源释放；业务已提交但管理宿主失联后的重复请求只重读同一交还收据，不重做版本命令或重复释放。
- Controller 和生产组合提供可信版本能力存在时的 handoff followup 接线，不依赖普通槽位。默认生产可信版本 / 原始验收计划构造仍未启用。
- 普通推进观察匹配新 cycle 的 execution、真实 agent_results.application_status=applied / effect_outcome=advanced、原生普通 Agent 完成事件及实际进程退出。旧完成记录、只有 ready/心跳/展示标签、其他 cycle 或仍有未退出进程不能构成推进证明。
- 新的非 Admin 故障观察会使 verifying / observing 的旧授权失效并回到 queued，仍保留正在退出的物理分配及全部历史收据；重复相同观察 ID 不重复失效。不允许旧已保存成功在新失败后再次应用或交还。

本轮新增 8 项交还 / 停止 / 原进程遗留 / 新故障失效契约；受控 Direct 工作项通过既有 direct run / submit、结果应用门禁和 execution 完成路径实际推进，未用仲裁或直接完成替代。最终全量 836 项通过、0 失败，日志 `/tmp/loopwork-verified-handoff-full-tests.log`，测试退出码 0。独立 `tsc --noEmit`、`git diff --check` 通过，隔离默认生产构建成功，日志 `/tmp/loopwork-verified-handoff-next-build.log`，构建退出码 0。3000 工作台 HTTP 200，业务 Loop 未启用，代码未提交或推送。

**截至该轮仍未完成完整闭环**：当时推进观察仅是业务侧只读证据查询；后续管理侧持久化和关闭门禁见下节。默认生产原始验收 / 版本能力，以及 runtime / run / task-wide execution 的恢复交还仍须实现。受控 Direct 测试不是三条真实模型修复闭环。阶段 5–7 的策略升级、明确来源的历史迁移、外部探测、UI、OS 托管 / guardian / Harness 自修复 / 版本兼容与切换回滚，以及整夜真实任务证据均继续按完整目标推进。

## 交还后管理侧持久化与自动关闭门禁

- 管理库新增不可改写的 followup 记录，保存每个验证代次的 handoff 与 business-progress。来源绑定原始 task、item、revision、dispatch epoch、实际修复所有者及独立验证版本；不能借旧 cycle 或其他工作项的结果证明恢复。
- 业务事务提交而管理确认中断时，重复操作读取原 handoff，补齐独立管理确认，不再次派发、释放或重跑版本命令。管理重启后保留两类收据和所有原失败。
- Controller 的可信观察适配器在正常业务通过原命令提交、结果应用和进程结束后保存推进证据；关闭前再次同步读取当前业务事实并复核运行意图与验证代次。仅 ready、缓存总结、伪造 execution ID、尚有阻塞 / 未退出进程或相同故障复发均不能关闭 Case。Agent 没有关闭命令。
- 同一故障复发后，新的 Admin status 与 Prompt 提供历史交还和业务推进记录，仍须重新验证，不能把历史成功当成本轮成功。
- 受控 Direct 路径已通过原 direct run / submit 与 applyAgentResult 门禁完成并由 Controller 自动关闭 Case；它不是三条真实模型修复闭环，也不证明默认生产原始验收计划、版本能力、其他作用范围恢复或阶段 5–7 已完成。

最新全量回归 843 项通过、0 失败，日志 `/tmp/loopwork-repair-followup-full-tests.log`，已检查进程退出码 0。独立 `tsc --noEmit` 通过。隔离默认生产构建退出码 0，日志 `/tmp/loopwork-repair-followup-next-build.log`；构建之后仅增补两条测试及本进度记录，没有改变生产实现。3000 工作台 HTTP 200，未启动业务 Loop、提交或推送代码。

## 持久化恢复决策与配置读取隔离

- 纯策略根据明确的终态失败 / 宿主失效和独立验证失败选择有限恢复方法，不枚举 Claude / Codex / OMP 的报错文本。每个管理尝试在分配事务中保存不可改写的 decision，列出真实失败 attempt ID；重复退出不会重复计数。
- 每两次尚未解决的失败升级调查方法：原始调查、最小复现、独立诊断、重新规划、其他已配置 Runtime。任何次数都不产生自动转人工动作。Prompt 与 status 提供宿主决策和具体方法要求；最小复现 / 独立诊断的完整宿主动作门禁仍须补齐，不能把要求本身称为已执行。
- Runtime 升级实际选择不同 executor / model / options 的已保存系统配置，不把重命名的相同配置当成换方法。候选列表持久化，管理 / 配置库重启失败时可继续使用；不全局激活候选，不调用业务 Agent 的私有配置，不发明默认执行器。
- 已确认退出的管理中断保存明确来源。用户停止和更新静默保留 interrupted 历史但不增加失败计数；宿主失效计一次。未知历史 interrupted 不靠错误文字猜测来源。
- 配置和候选读取分别有 5 秒超时及取消边界，避免配置数据库挂住使独立 Admin 无法启动；读取超时使用此前配置，迟到读取结果不能覆盖缓存。这个边界不是 CLI 启动 / 长命令超时，不改变现有 20 分钟 CLI 启动允许时间。

此轮尚未完成整个阶段 5：有效进展的可信事实归一化、持续输出但不推进的监督、最小复现 / 诊断动作落地、真正外部硬故障证据及持久化自动探测、明确来源的历史介入迁移仍待实现。默认生产验证能力、其他作用范围交还、阶段 6 的 OS 托管 / Harness 自修复和阶段 7 的真实模型三闭环及 8–12 小时验收继续保留。

最新全量 852 项通过、0 失败，日志 `/tmp/loopwork-recovery-strategy-full-tests.log`，已核对测试进程退出码 0。独立 `tsc --noEmit` 和 `git diff --check` 通过；隔离默认生产构建成功，日志 `/tmp/loopwork-recovery-strategy-next-build.log`，进程退出码 0。没有启用业务 Loop、提交、打 tag 或推送代码。

## 独立诊断请求与真实检查事实

- 复用既有 Admin submit 与独立 verification worker，新增 diagnosis-requested 用途，不增加第二套进程执行器或任意“直接完成”能力。工作区诊断仍须先接管，提交后本轮 Admin 实际退出，才分配独立检查。
- 诊断的原失败 / 验收 / 版本命令由可信宿主能力授权，不由 Agent 的命令建议替代原始契约。诊断不要求伪造修复 change 证据；真正修复验证继续要求本轮 action/change 和已获工作区所有权。
- 独立诊断在原失败非零时继续读取其他验收及末尾版本，完整保存真实输出和退出证明。版本不匹配、未知 exit code、后代未退出或取消仍拒绝完整诊断；原始失败不是宿主 CLI 自身失败。
- purpose 与原始提交分开持久化并互相校验。诊断即使全部通过也只交回 queued 调查，不能进入 observing、交还业务或关闭 Case；purpose 元数据缺失时从保留的原始提交核对，不能把诊断升格为修复通过。
- 管理侧从真实检查的原始 target / result code 计算诊断事实指纹，排序不影响身份。改版本号、重写命令 / stderr 或重新排序但验收结果未改变，不算新进展；重复无效诊断进入持久化恢复决策、升级方法，不转人工。检查版本仍独立校验并保留，并未从验证门禁移除。
- 诊断收据在实际检查后、进程清理前保存；宿主死亡后确认退出再优先恢复已有收据，不重复原检查。新原始故障使旧诊断授权失效，但保留收据历史。status 和 Prompt 提供诊断引用，完整输出保存在原 evidence / receipt。
- 计划读取复用有界 pre-spawn lookup，默认 5 秒超时并支持取消，迟到读取不能启动 worker 或补写授权计划。配置读取也复用同一边界。

**当前证据范围**：真实 Node worker 对未实现 fixture 执行了三轮完整诊断，确认 `[版本 0，复现 1，验收 1，版本 0]` 与真实 stderr，并实际清理进程。它证明诊断与重复无效结果的处理，不是三条真实模型修复闭环。默认生产原始验收 / 版本计划构造仍未启用；其他作用范围交还、普通业务停滞接入、历史来源迁移、外部自动探测、宿主 / Harness 自修复和整夜真实任务验收仍须完成。

最终全量 871 项通过、0 失败，日志 `/tmp/loopwork-independent-diagnosis-full-tests.log`，已核对进程退出码 0；独立 `tsc --noEmit`、`git diff --check` 通过。最终隔离默认生产构建通过，日志 `/tmp/loopwork-independent-diagnosis-next-build.log`，退出码 0。3000 工作台 HTTP 200，没有启动业务 Loop、提交、打 tag 或推送代码。

## Admin 调查活动停滞监督

- Invocation 核心只接受注入的 monitor（首次输出、归一化事件、失败查询），不识别 Admin 故障类型。监督查询独立于日志 / 遥测持久化队列，监测错误也走既有物理终止路径，不因错误继续同步处理整批事件。
- Admin 的 20 分钟活动窗口从首次输出开始，初始静默仍由既有 startup timeout 管理。自然语言输出、摘要、不同调用 ID、重复同一工具与参数、status 和自行记录 evidence 均不能重复刷新活动窗口。
- 成功完成的新工具操作形成持久化调查检查点，身份只包含规范化 tool/input，不包含输出日志或时间。显式非零退出不形成检查点；部分 Runtime 仅报告 tool success、没有数字退出码时，它只能表示调查活动，不能表示已验证通过。
- 新 Shell 调用最多获得 20 分钟等待宽限，每个活动窗口仅一次固定截止，重复启动或失败再启不续期。历史已执行命令在重启后仍可获得有界等待，避免误杀需要十多分钟的重测，但历史检查点不当作新进展。
- 管理库保存 Case 范围的检查点，跨重启重复事实不会重新写入或续命。令牌及敏感字段脱敏，大参数不通过截断 JSON 制造监测异常；检查点绝不推进业务工作项、替代独立验证或关闭 Case。
- 已用真实 Node CLI 注入持续输出 / 同文件反复读取和不同调用 ID：停滞监督实际终止进程组，确认退出后保留原故障并回到 queued，下一次管理决策保留本轮失败。不使用直接仲裁完成或假进程取消替代。

**剩余范围明确**：工具活动只能证明调查步骤发生，不能判断新工具参数是否语义有效；基于原失败 / 原验收结果的可信有效进展检测与独立诊断动作仍须补齐。普通业务 invocation 的停滞观察接入、默认生产原始验收 / 版本能力、其他作用范围交还、历史来源迁移、外部硬故障探测、宿主 / Harness 自修复及三条真实模型闭环和整夜运行均未因此完成。

最新全量 863 项通过、0 失败，日志 `/tmp/loopwork-admin-activity-full-tests.log`，已核对进程退出码 0；独立 `tsc --noEmit`、`git diff --check` 通过。最终隔离默认生产构建通过，日志 `/tmp/loopwork-admin-activity-next-build.log`，退出码 0。3000 工作台 HTTP 200，没有新增服务实例、启用业务 Loop、提交或推送代码。

## 独立 Admin 调用与命令协议

- 把不依赖业务存储的物理调用核心提取到 `agent-invocation.ts`，业务 `delegation-execution.ts` 仅组合原业务进程登记与屏障。Admin 注入自己的管理记录，不导入业务数据库、任务或 Intervention。
- 新增 `loop-admin` 命令入口，并纳入 desktop runner 打包。命令凭证绑定 Case / attempt / session / 当前监督代次与意图；先读取 status，再记录真实调查证据并提交验证请求。令牌只通过环境传递，管理库保存哈希。
- 管理提交严格校验原始故障引用与本轮 action/change 证据，重复提交幂等，不允许改写、直接完成 Dev/Test 或关闭 Case。命令文件仅可读取当前执行临时目录，使用 realpath 防止符号链接越界。
- 宿主退出后已有提交先恢复，物理退出未确认时不应用、更不启动新一轮。用户停止或旧监督代次不能提交迟到结果。
- `admin-execution.ts` 使用真实物理调用核心启动管理 CLI，清理进程后才处理结构化提交；证据写入失败不能请求修复通过。POSIX 进程组完整退出才收尾；Windows 根失联仍保留屏障，等待可靠 guardian / Job Object 实现。
- 管理命令提供 POSIX / PowerShell 可执行示例；清除继承的普通 execution / internal / intervention 权限环境，日志与工具证据屏蔽当前管理令牌。
- 日志拒绝或永久挂起不会卡住启动、杀进程或执行收尾。日志写入和持久化证据均有独立等待边界；证据挂起返回明确失败，不把缺失证据当成功。

真实 Node 子进程集成已验证 status → 拒绝伪造令牌 → 隔离 fixture 文件修改 → 本轮证据 → submit → 物理退出 → verifying。它证明管理执行链路，不是三个真实模型修复闭环，也未替代生产接管、版本独立验证或整夜验收。
安全示例、持久化挂起与启动前取消修正后，最终全量回归 780 项通过、0 失败，输出 `/tmp/loopwork-admin-invocation-full-tests.log`；独立类型检查与 `git diff --check` 通过。最新实现隔离生产构建通过，日志 `/tmp/loopwork-admin-stage3-next-build.log`，退出码 0；未改变 3000 实例或其缓存。构建后仅新增启动前取消测试与此进度记录，没有更改生产实现。

接下来仍须把管理入口连接 Lifecycle / 故障观察与业务 Intervention，实现写入前接管、独立验证与交还；再统一策略升级、宿主托管、自构建切换回滚和 8–12 小时真实验收。以上完整目标保持不变。

## 故障观察桥接与写入前接管

- 迁移 124 增加明确的 Intervention 来源与 RepairCase 关联，以及业务事务内的观察 outbox。人工输入被保留；未知历史记录不会仅因 awaiting_human 而自动转换。新的角色阻塞、终止命令仲裁、重复验证失败和原生执行耗尽产生 agent-fault 观察。
- 业务状态与观察一起提交或回滚；管理存储先保存观察，再原子确认业务关联。跨两库崩溃重放同一观察 ID，不重复创建 Case，不改写原始验收 / 执行快照。
- Work Item 故障范围使用 task / work_key，替换 revision 后同一失败继续原调查历史。暂停需求的 outbox 不派发，但原始观察保留待恢复。
- 已关联 RepairCase 的事项不能再由旧普通介入队列认领；旧 Agent 命令也不能借原仲裁权限改业务状态。Controller 提供独立发现入口；发现适配器读业务库失败不阻止已保存的管理调查继续。
- 迁移 125 增加不随租约、逻辑 claim 或暂停清理而失效的修复资源所有权。管理用例先持久化 draining 屏障，再取消同工作区冲突执行，独立于业务 Runner 确认物理退出，最后才返回 owned 工作区。
- 清理结果为空不代替退出证明；还检查持久化进程与资源屏障。重复清理包括上轮已逻辑取消的源执行，不能遗漏无资源屏障的原介入进程。
- 派发、实际资源获取和最终 pre-spawn 三处都拒绝修复中的冲突调用，包括同任务及同项目的另一就绪任务。其他项目仍然可派发，不取消无关执行。
- 管理凭证、原始来源 item / revision、暂停 / 结束、人工输入和工作区路径在异步清理前后复核。监督权或意图失效不会授权写入。项目目录修改 / 删除也检查实际进程和修复资源，而不只看逻辑 running。
- 历史库合并不复制其他管理库的 Case 链接、待派发 outbox 或修复所有权；保留原始历史库不变。

已通过真实 Node writer 的独立宿主清理与定向契约测试；防御性派发 / pre-spawn / 项目修改增补后的最终全量 788 项通过、0 失败，输出 `/tmp/loopwork-repair-takeover-full-tests.log`，已核对进程退出码 0 与终态汇总。独立 TypeScript 和 diff 检查通过；最新实现的隔离生产构建退出码 0，日志 `/tmp/loopwork-repair-takeover-next-build.log`。3000 工作台 HTTP 200，未新增 Web 实例或改变其构建缓存。

**尚未连接的生产路径**：生产宿主初始化 / 停止桥接、独立验证 / 原版本核对 / 业务推进观察。接管动作投递、凭证结果和旧管理所有者物理退出后的资源转交已实现，见下节；尚未由生产宿主启用。不能宣称真实模型已能从生产错误自动修完。阶段 5–7 的策略升级、外部等待自动探测、OS 托管与 Harness 切换回滚、三条真实 Agent 闭环及整夜证据仍待完成。

## 管理命令接管与代次转交

- 管理库持久化 `workspace takeover` 请求；请求绑定凭证、status 检查、原始业务 item/revision 与稳定 key。重复请求不重复创建或改写动作；CLI 不导入业务存储，也不直接修改业务状态。
- Controller 通过 `manageActions` 注入宿主能力。业务适配器执行已验证的接管用例，将 draining/owned 结果回写管理模块；宿主结果另留下不可改写证据。pending/draining 不暴露写入路径，只有 completed+owned 提供工作区。
- 业务 Work Item 的代码修复提交还需本轮有效接管，不能先写一条“change”证据就请求验证。协议示例明确申请不等于授权；提交后不能追加管理动作。
- 旧修复屏障不因 Admin 失败而消失。新代次接手须在管理库中确认旧调用已物理收尾，保持同 Case 和资源屏障，并重放原清理目标。跨代次历史保留，未确认旧退出时不允许新 Admin 分配。
- 修复执行器提供已知启动前失败的正向退出证明，避免没有启动 CLI 却永久保留未知 PID 屏障；一般 Controller launch rejection 仍保守不清屏障。日志改用异步落盘，并保留日志失败的管理诊断。
- 真实 Node 管理 CLI 在隔离诊断目录启动，通过命令申请业务工作区；宿主终止旧写入进程并交出路径后，CLI 实际修改 fixture 文件、记录证据、提交独立验证请求。已核对实际文件与旧进程退出；Case 仍 verifying，资源屏障保留，未冒充独立验证或业务完成。

定向命令 / 接管 / 物理执行检查通过；本轮全量 792 项通过、0 失败，日志 `/tmp/loopwork-admin-managed-actions-full-tests.log`。独立类型检查和隔离生产构建通过，构建日志 `/tmp/loopwork-admin-managed-actions-next-build.log`。最终来源字段防覆盖和文件核对增补后的结果继续以同路径终态为准。
曾有一次编译后 Lifecycle 入口达到 15 秒超时；独立重跑、原组合重跑和全量均通过，尚未确认根因。入口测试增加活动资源诊断与 stdout/stderr 上下文，没有提高超时或强制退出来掩盖；后续故障注入 / 负载验收仍须观察。

下一步仍按完整目标连接生产宿主与用户停止，然后实现独立验证、版本核对、交还与实际推进观察；不能把这些子进程 fixture 当成三条真实模型闭环或整夜运行证据。

## 最新补充：安装选择、暂存与外部退出屏障

本轮将普通 standalone/桌面启动接入管理库的持久化安装选择，并补充受代次约束的外部宿主核心及内容寻址快照。更新结束与实际选择在同一事务提交；旧入口重启会实际执行所选 bundle。普通发行 bootstrap 不自动钉为本地修复安装，以保留下载更新路径。物理路径隔离覆盖别名/链接与未创建目录祖先。

更新取消不能吞掉读者或宿主退出失败，也不能因读者同步抛错而跳过其他进程终止。更新成功不等于激活宿主已经退出；Controller shutdown 清理捕获代次，未确认退出则返回失败，外部宿主不释放租约。

24 项定向、全量 1031 项、独立类型检查及隔离 Next/Desktop runtime 构建通过。真实打包 staging、独立快照激活、控制器结束后物理退出、两次旧入口跳转所选代码的持久化证据位于 `/tmp/loopwork-runtime-exit-proof.uGfWZ3/evidence.json`；范围与原始标识见 `external-runtime-update.md`。仅有 3000 Web，工作台 HTTP 200，未启动主 Loop、提交或发布。

完整目标仍未完成。外部宿主原生普通进程注册/转交/排空与 OS 更新入口、Admin 到 Harness 隔离修复部署、外层 GUI/bootstrap 替换、Windows containment、发行安装器与本地修复选择协调、Next 可变缓存外置仍待打通；真实模型三闭环和 8–12 小时整夜证据缺失。这些原始范围不能由本轮受控快照/进程实验替代。

## 最新补充：原生普通宿主组合已接线

原生普通宿主新增管理库持久化分配、实际父 PID/启动身份和私有就绪协议；已连接外部 root 核心、更新控制器及真实数据库兼容实现，打包导出 `external-runtime.cjs`。普通宿主独立观察外部代次/父连接，清理后代失败不阻止根终止却保留 exited 屏障；未知分配和未完成更新不得重复 spawn。

17 项定向、全量 1036 项、独立类型检查及隔离 Next/Desktop runtime 构建通过。真正打包组合入口启动普通 Electron 宿主、重复 tick 复用同一私有连接、退出前不释放 root、退出后管理库 owner 清空的证据位于 `/tmp/loopwork-native-root-proof.609AnG/evidence.json`；再次安装字节校验见同目录 `post-verify.log`。私有库没有运行 CLI，不能把此证据当已有独立写入 CLI 的完整排空验收。标识与完整范围见 `external-runtime-update.md`。

下一步必须继续补实际独立 CLI / 未登记旧宿主退出能力、稳定 OS 外部入口与 cached Admin runtime 修复部署；不能以强制注入端口作为最终成功。真实模型三闭环和 8–12 小时整夜验收仍缺失。主 Loop 保持 stopped，仅保留 3000 Web，未提交、推送或注册新 OS 作业。

## 最新补充：真实冷启动现场与可再次关闭

隔离全量验收曾发现 launchd 恢复检查失败及受控假 CLI 残留。PID 登记不再等同 running：必须真实启动身份落盘；未知启动窗仍保留屏障，尚需原生 guardian 补齐。失败测试保留私有数据库/日志/文件现场，清理汇总原错误与所有清理失败，不吞掉原始诊断或漏清其他进程。原失败、未提高时限的 launchd 重跑及文件保留证据详见 `external-runtime-update.md`。

外部 root 关闭失败后可以再次尝试清理捕获代次；仍禁止重新派发，确认物理退出前不释放 root。同步清理错误不能阻止另一组进程终止或覆盖启动错误；更新关闭等待已取消在途操作。编译环境隔离实际活跃数据库/命令凭证；数据库回滚读者拒绝 NULL/非文本历史迁移，保留原数据库字节。

最终隔离全量 1046 项、独立类型检查、Next/Desktop runtime 构建全部退出 0；真正打包的关闭拒绝→再次确认收尾证据 `/tmp/loopwork-shutdown-retry-proof.dw6aU4/evidence.json`，独立只读租约、实际父子退出与安装字节复核见 `post-verify.log`。详细版本标识和受控证据边界见 `external-runtime-update.md`。没有把该无业务 CLI 的假证明拒绝实验计为真实修复闭环。

真实模型验收尚仅准备独立完整源码 worktree 和样例仓库，临时切换唯一 3000 Web 的许可待确认。三条真实闭环、整夜、生产 OS 外部根/独立 CLI 容器及 Admin 源码修复构建部署等原始范围仍需完成，目标保持未完成。

## 最新补充：外部普通宿主的业务 CLI 已独立登记

外部普通宿主在实际安装/PID/身份核验后认证 CLI 登记协议；业务 execution 和无 execution ID 的宿主 helper 都在 spawn 前登记独立管理分配，绑定当前运行意图/root 代次/所选安装和实际同组调用者。marker 未到仍为 launching，迟到信息不能覆盖其他 PID/marker 或重新开放排空入口。终止先封闭分配，独立排空已登记 POSIX 组；业务库损坏不阻止它，存储异常不抑制根终止，但未证明入口关闭与全部退出时保留屏障。完整原生 containment 仍必需。

36 项定向、1054 项全量、独立类型检查、隔离 Next/Desktop runtime 打包全部退出 0。实际根退出后仍写入的同组子进程已在受控测试中终止且文件保持稳定，损坏业务库字节不变；真正打包宿主初始化 certified CLI 协议、退出及不可变安装复核见 `/tmp/loopwork-independent-cli-proof.zm52os/{evidence.json,post-verify.log}`，完整日志与源码/产物标识见 `external-runtime-update.md`。

这补齐了普通宿主的已登记 CLI 台账和清理接线，不是 Windows Job、逃逸/未知启动窗、未登记旧宿主、OS 外部入口或 cached Admin Harness 源码修复部署的最终完成。主 Loop 仍 stopped，真实模型三闭环与整夜未执行，尚待确认隔离 UI 临时切换许可。完整原目标不变，未提交或发布。

## 最新补充：外部 root 启动失败进入独立 RepairCase

原生外部组合现在把普通宿主的 selection / validation / startup 故障写入管理库，不初始化业务库。观察保留实际尝试的安装、所选 revision、运行意图 revision、root 代次、进程分配与原始错误原因；未经过字节校验的版本显式标记 unverified-attempt。相同 root 的不同版本/错误合并同一调查，同时每次失败保留独立观察。错误链、聚合错误、进程预览有上限，诊断脱敏但不把原始原因替换成通用失败。

记录事务再次验证 root、意图、所选版本和更新状态，故用户停止、停止后重启、fencing、更新中的迟到失败不会重新生成修复工作。记录失败本身不能阻止物理清理或覆盖原始启动错误。受控测试还验证：两份业务库损坏时，独立 Controller 可以从管理库读到故障，使用已配置的 durable-cache 调用并实际收尾；这是 Node 缓存消费者，不是模型修复或生产 root 自动启动 Admin 服务。

真正打包实验暴露了原生 spawn 失败把 ENOENT 替换成“未分配 PID”的缺陷，已修复为保留 OS code / path / syscall，并仍等待 close 才清空已证明没有子进程的分配。严格回归不再接受“ENOENT 或 PID”这类宽松断言。25 项定向、1063 项全量、独立类型检查、隔离 Next/Desktop runtime 构建退出 0。重新打包的 ENOENT 与私有产物哈希损坏实验及独立退出后只读复查均退出 0，详见 external-runtime-update.md。

下一步的关键生产缺口仍是：由稳定外部 root 持续托管独立 Admin 服务，把准确源码修复 / 隔离构建 / 外部切换 / 原始验证 / 业务交还实际接通；补齐完整未知后代 containment 与 OS 入口。普通业务进展监控已在下节接线，仍需真实负载验证。三条真实模型修复闭环及 8–12 小时整夜证据尚未执行，不能以以上故障记录测试替代。未启动主 Loop、切换 Web、提交或发布，完整目标保持未完成。

## 最新补充：普通业务 execution 的进展监控默认接线

- executeDelegation 的业务 composition 默认安装与 Admin 共用的活动监控；核心 invocation 仍只处理标准事件、取消与实际退出，Runner 不增加停滞分类分支。普通业务默认 20 分钟活动窗口，长 shell 在未过期时获得一次有界执行窗口；更多输出、started ID 和失败工具不能延长最早窗口。
- 单次 execution 的 started_at 与最后真实完成活动时间决定续跑 deadline，不因 CLI exit 0 再次启动而清零。缺失/非法启动时间或损坏活动时间被拒绝，不能凭未知记录发新窗口。相同 Work Item / dispatch generation / agent / pipeline 的重试加载已完成操作指纹；新的真实派发 generation 可重复验证操作。这里只判断观察到的新完成操作，不证明功能实现或验收通过。
- 新活动写入现有 execution_receipts 的 activity_checkpoint，32 字符摘要、实际完成时间、来源与 acceptanceVerified=false；不存工具输入正文。observe 仅更新内存，持久化走现有有界证据队列并再次检查 running 来源；没有新增数据库迁移、同步 OS 检查或在 Runner 心跳中扫描进程。写入失败仍沿执行证据失败处理，不吞掉原故障。
- invocation 返回结构化 terminationKind=activity-stalled，Execution Coordinator 记录 agent-stalled，走现有持久化失败 / 恢复 / Admin 升级路径；不自动标记 Dev/Test 完成。用户停止与已有结构化结果优先恢复的路径保持不变。
- Codex 完成事件若携带 command / arguments / changes / query，解析器现在保留该输入身份：此前仅保留 output，completed-only 调用无法识别有效活动。回归同时覆盖 Claude / Cursor 的 started → completed 配对和 Codex completed-only 重复事件。

86 项定向、最终隔离全量 1073 项、standalone tsc、Next 及 Desktop runtime 均退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/business-activity-targeted-final4.log`、`business-activity-full-final.log`、`business-activity-tsc-final2.log`、`business-activity-build-final.log`、`business-activity-desktop-final.log`。真实 Node CLI 的三个受控 runtime 协议均持续输出/变换 tool ID，却只形成一次活动检查点，最终实际 PID 消失、execution_processes exited；永久挂起日志 sink 也不能阻止退出。它们不是真实 Claude/Codex/Cursor 模型调用，也没有执行原业务验收，不能计入三条修复闭环或整夜。

本次隔离构建身份（补本文档前）：源码 `8ca851ab2ff6ec35bf2e27b7c9b40ef2b02a7ee7c020702b9aefef1774ec95f3`，桌面产物 `9e74e7d3549f1fab9ede84fd70b45ae76a4666281789073971264b5709c0da63`。主 Web 仍为 3000 / PID 54354，HTTP 200，主 Loop stopped；未提交、发布或启动新的 Web/OS 作业。完整目标仍待稳定外部 Admin 服务、真正源码修复部署与交还、未知后代 containment / OS 接线及真实模型三闭环、8–12 小时验收，不能据此宣告完成。

## 最新补充：原生外部 root 持有管理调度与防休眠

- 原生组合必须提供独立 Admin 启动/实际退出能力，在普通业务启动前初始化真正的 Controller。管理 owner 绑定 root；业务启动失败不关闭管理定时器。管理能力调用校验 root 代次，不允许尚未取得 root 的观察者提前获得管理所有权。
- 外国管理租约仍有效时先排空捕获的旧普通宿主，再尝试管理接管；接管失败不启动新普通宿主。正在进行的合法外部更新仍可以排空/推进，不能被 observer 分支锁死。完整 OS 入口及未知/未登记宿主处理仍未完成。
- root 关闭、fencing 同时清理更新、普通宿主、Admin 与防休眠资源；一组失败不能阻止其他组收尾。Admin active 或 owned durable launching/running 分配尚未证明退出时保留管理租约，允许再次 shutdown 核对，不能凭没有 PID 推断没有 spawn。
- 外部 bundle 导出已有 configured Admin launcher、真实退出适配器和 telemetry composition，无需导入业务 Lifecycle 取得这些能力。编译/加载边界测试拒绝业务数据库、任务/介入、Web/Electron 和测试 fixtures 的传递依赖。生产业务能力仍需独立 worker/broker，接口注释本身不是已完成的进程隔离。
- 真正打包实验发现子宿主 stdout-only fatal 被父进程漏采，已补充有界 UTF-8 流与逐行故障保留；后续大量收尾输出不能覆盖具体原因。故障和噪声合并成大块时，必须先解析完整行，再限制未完成行缓冲。回归保留跨 chunk 中文、脱敏、实际退出和 root failure 传递断言，未放宽退出门禁。

最初全量失败现场 `/tmp/loopwork-real-repair.fWroPo/root-management-full.log` 显示两条 stalled Admin CLI 均已实际退出，但测试随后裸 claimNext 生成未知分配。测试改为 Controller 真正启动/结束续轮，不让 shutdown 清掉未知屏障。stdout 合并时序失败现场另保留于 `root-management-full-final9.log`，已修复而非提高超时或放宽断言。

最终定向 52 项、全量 1081 项、standalone tsc、Next 和 Desktop runtime 全部退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/root-management-{targeted,full,tsc,build,desktop}-final10.log`。构建身份（补本节前）：源码 `02a9af7e3146aa2c768bdca4681a5e98685336d39a5204ec1c96e7b32887ab29`，产物 `348086f0cad56ba94a5a3fc4faa99fd452e4e3fe1719656a848cd19167979e1e`。

真正打包与独立退出后复查证据 `/tmp/loopwork-root-management-final.kjxacs/{evidence.json,verify.log,post-verify.log}`：外部父 18749、业务宿主 18767、受控管理调用 18801、防休眠 caffeinate 18760 均已退出；实际 pmset assertion、精确安装字节、空 root/管理租约、原始损坏业务库字节均已核对。管理使用默认定时器、durable-cache 配置，两个 Case 仍 queued，没有宣称模型修复或业务通过。此调用处理了子宿主先报告的 Case；父 root 的启动 Case 同时持久化，不把本次一次调用冒充所有 Case 均已服务。

下一步还需管理队列公平性：claimNext 当前按 created_at 排序，最旧失败 Case 可能反复占管理槽，需证明多个 Case 都能继续调查。稳定 OS root 入口、业务能力隔离 broker、准确源码实际修复/构建/切换/原始独立验证/业务交还、未知后代与 Windows containment、真实模型三条闭环及 8–12 小时整夜证据仍待完成。主 Loop stopped，仅有 3000 Web（HTTP 200）；未切换 UI、提交、推送、注册新 OS 作业或清理工作区。完整目标保持未完成。

## 最新补充：管理调度使用同一条持久化公平队列

- 新增独立管理元数据 repair_schedule_queue，使用单调 ticket 而非改写实际时间戳。创建 Case 时排队，只有成功的受代次保护分配才移到队尾；新观察、重复日志、失败结果和宿主重启不能重新抢队首。同毫秒多轮分配仍能轮转，新 Case 加到已有等待项之后。
- Controller 改用 claimScheduled，在同一事务选择调查、到期外部探测或独立验证；不再无条件先选择 verification。原 claimNext / claimVerification 仍保留各自用途并使用相同队列顺序。物理退出、运行意图、代次校验和探测冷却条件不变，不借公平性解除未知进程屏障。
- 既有管理库按最后实际分配时间/原创建时间补齐缺失 ticket；重开已完成迁移的库不重排队列，不改原始观察或执行记录。仅在独立管理库创建元数据，不新增业务迁移。
- 原停止竞态测试现在在新的原子 claimScheduled 事务前提交跨宿主 stop，而不是在持有写锁后用另一个连接强行写入；仍验证停止为 cancellation、无执行分配/错误扣费或诊断错误。
- 旧 launchd 全量测试曾把所有 Case 的假 CLI 都设为永久挂起，导致新队列正常服务独立配置故障后，目标 Case 在 45 秒内无法轮到。失败现场 `/tmp/loopwork-real-repair.fWroPo/admin-fairness-full.log` 保留；目标旧 CLI 已实际退出，另一条 CLI 也经 finally 确认终止。现在仅目标 Case 故意挂起，其他受控 CLI 正常失败收尾，再断言另一故障得到服务、实际退出，以及原 Case 恢复/用户停止。没有提高原 45 秒恢复观察上限或生产执行窗口。

定向管理/边界检查 31 项、独立 launchd 恢复检查 1 项、最终全量 1085 项全部通过；standalone tsc、隔离 Next/Desktop runtime 都退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/admin-fairness-targeted-final.log`、`admin-fairness-launchd.log`、`admin-fairness-full-final.log`、`admin-fairness-tsc-final2.log`、`admin-fairness-build-final.log`、`admin-fairness-desktop-final.log`。构建身份（补本节前）：源码 `4185c8bc116c5e399b1175e2f09cebbd23666700f97f8475f5c37a95bd1d10f9`，产物 `92d3af5d0060e45345c62c775de341c75b1d6d90763ba1be9600b2e22be0c64b`。

真正打包与独立只读复核 `/tmp/loopwork-admin-fairness-final.TCMyEn/{evidence.json,verify.log,post-verify.log}`：默认管理定时器先为子宿主故障启动受控调用 48327，再为父 root 启动故障 Case 启动调用 48378；不是手动 reconcile 管理队列。父 48196、业务宿主 48229、两次调用及 caffeinate 48216 均实际退出，管理/root 租约为空；两份损坏业务库字节及暂存安装哈希不变。两个 Case 均 queued，未宣称模型修复、独立业务验收、更新部署或实际业务推进。

已复查 native external root 当前仍只被测试/实验调用；OS 配置生成和旧 standalone/desktop 宿主尚不是完整稳定外部 root 部署。下一步应完成独立配置/业务能力 worker 或 broker，再接入实际稳定入口及 Admin 源码修复部署/验证/交还，而非继续把注入端口当生产接线。未知/逃逸后代与 Windows containment、真实模型三条闭环和 8–12 小时整夜验收仍未完成。主 Loop stopped，仅有 3000 Web；未提交、发布、清理工作区或新增永久 OS 作业。完整目标保持未完成。

## 最新补充：独立配置与业务能力 worker 已接线并打包验证

- `native-admin-management.ts` 提供外部 root 的真实管理组合：配置刷新、故障 outbox 发现、资源接管、验证工作区校验和验证后交还，均通过专用业务能力子进程调用现有可信用例。外部 root 的 bundle 不加载业务库、Next 或 Electron 实现；管理配置缓存和有限管理命令仍在独立管理库中。
- `admin-business-worker-entry.ts` 仅接受私有父进程 IPC 的有限请求。实际父子 PID、root/管理所有权、运行意图、更新门禁、内容寻址安装的字节身份验证后，才加载业务能力模块。验证工作区请求只传 Case 与冻结输入指纹，在子进程按当前分配直接重建权威输入，不扫历史、不接收任意 SQL 或业务完成命令。
- 独立管理表 `admin_business_worker_processes` 在 spawn 前保存分配，随后绑定不可覆盖的实际 PID/启动身份/进程组；同一时刻只允许一个未确认退出的能力 worker。请求串行，超时、用户停止、管理代次失效和 root 关闭均取消实际子进程；请求返回前确认物理退出。未知启动窗不能当作 no-spawn，保留屏障并阻止后续能力调用。
- 清理保存本地真实身份，管理库读取/确认退出失败不能跳过已知进程的实际终止；退出证据未能落盘仍保留分配，之后可重试确认。Controller 的能力停止不排在慢 discovery 后，能力清理失败也不能跳过 CLI 取消或释放管理租约。原生 root 在前代能力写入者退出未知时保持独立管理运行、清理普通宿主并推迟普通业务准入。
- worker 环境移除全部继承 `LOOP_*` 权限/测试/路由变量，仅重建自身安装和私有数据路径；配置响应使用严格 schema，不存提供商凭证。业务故障通过事务内的 root/意图/安装校验写观察，停止与迟到观察竞态不创建新故障；健康配置预缓存，库损坏时保留原有配置和已配置 alternatives，不擅自换模型。

定向管理/能力/边界检查 24 项通过；首次超时测试失败原因是受控 Node 没注册 message 监听，IPC 变成 unref 后主动退出，出现 EPIPE 而非真正挂起。失败日志 `/tmp/loopwork-business-worker-targeted.log` 与现场 `/var/folders/cq/4n_2stz915975plmrvgsgh_w0000gn/T/loopwork-test-bfkU9l` 保留。已改为实际接收请求但不返回，验证真正超时终止，没有放宽断言或生产超时。

最终全量 1093 项全部通过，standalone TypeScript、隔离 Next/Desktop runtime 构建退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/business-worker-{full,tsc,build,desktop}-final.log`；源码 `fc6f64685fac7c0a051a4ffe8973a0ad97a084756e4f60d2c4cb980376c82b31`，安装产物 `2c63de4e73e96545482a5d592c226dff443720fc184d1ad41a39e235b31941e7`。

真实打包能力验证与独立只读复查 `/tmp/loopwork-business-capability-proof.mCP6YU/{evidence.json,verify.log,post-verify.log}` 均退出 0：父进程 89145 与 11 个实际能力 worker 均已退出，全部管理屏障 exited，root/管理租约为空。实际调用配置、空 outbox 发现、空接管/交还队列及管理组合预缓存；两份业务库损坏后返回具体 SQLite 错误，损坏字节和不可变安装哈希不变，缓存模型 `proof-configured-model` 保留。两个故障 Case 仍 queued，没有模型调用、修复尝试、业务完成或 Case 关闭。本证明不把空动作队列等同于实际资源接管/业务交还，尚未证明具有真实 Case 的验证工作区 worker 路径或源代码修复。

下一步仍需把该组合接入稳定 OS / desktop / standalone 外部 root 入口，而非仅导出与实验调用；完成真实 Admin 的准确源码修复、隔离构建、外部切换/失败回滚、全部原始验收独立验证、物理资源交还和正常业务实际推进。未知/逃逸后代与 Windows Job containment、三条真实模型修复闭环及 8–12 小时整夜证据仍未完成，完整原目标保持 active。主 Loop 只读复核 stopped/normal，原 3000 Web 未切换、HTTP 200；未提交、推送、清理代码或注册永久 OS 作业。

## 稳定独立入口与真实重启中的代次修复（2026-09-16）

已新增 `createNativeExternalService` 和打包 `external-host.cjs`：独立 root 先取得管理所有权，再通过短期业务能力 worker 做只读旧宿主 audit，最后启动内容寻址安装中的业务宿主。standalone 托管默认指向该入口；配置仍仅生成文件，不自动注册或覆盖。root 不加载业务初始化、Web 或 Electron 实现，不启动 HTTP。新 `host-audit` 协议允许停止/更新静默下的只读诊断，仍校验 root/管理代次、意图版本、实际安装和物理 worker 退出。

候选健康验证省略自定义 port 时，使用实际私有 IPC 重新读取版本、监督租约、模式、运行阶段和错误，不将 ready 消息等同健康。定向检查覆盖激活前后探测及存活但报错版本的子进程；尚未以不同真实产物的完整更新闭环证明该默认探测。最初测试漏推进 candidate-activating，被现有门禁正确拒绝，修正的是测试顺序而不是削弱门禁。

另修复当前 root 的能力清理竞态：prepareCapabilities 不再杀死本 broker 正在执行的能力 worker；未知的同 root 分配保留屏障并拒绝并发接管。只读旧宿主 audit 要求实际进程组、不可变进程身份及唯一来源，无法证明时不得启动普通业务。日志队列有界，完成物理退出后最多等待一秒写日志，避免日志卡住使 OS root 永远不能退出。

首轮真实重启发现两个业务宿主均得到 supervision token 1。原因是业务生命周期 shutdown 删除租约，后续 acquisition 重建 token 1；这也会令历史来源匹配歧义。现释放租约保留 counter、清空 owner 并立即过期；同 owner 过期后也取得新代次，历史重复 token 无法作为唯一已退出来源。新增三次宿主启动/释放的契约检查。

最终全量 1099 项通过，standalone TypeScript、隔离 Next 与 Desktop runtime 构建均退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/business-fencing-{full,tsc,build,desktop}.log`。源码 `ce19a31737d4132ef867a951605f003262f6a78007d11ceaa8fe002be31ebb39`，产物 `544d03cd3aeb0eb6b019b854c08ff8dddc75c5b61a300f0ab1017d4a6973afdf`。

新产物真实入口证明 `/tmp/loopwork-fenced-entry-proof.TtPhxI/{evidence.json,verify.log,post-verify.log}`：两次正常启动/退出后代次为 1、2；双业务库损坏时独立管理仍续租。父进程 39374、三个 root 39383/39507/39573、业务宿主 39464/39546 和三个能力 worker 均已实际退出；只读复查进程组为空、租约清空、屏障 exited、停止意图与损坏哨兵字节保持不变。零模型调用，没有业务修复成功声明。

默认临时 launchd 证明 `/tmp/loopwork-fenced-launchd-proof.bpSQLQ/{evidence.json,verify.log,post-verify.log}`：强杀 root 39392 后 OS 启动 39513，后者先 observer，约 37 秒后真正取得租约并恢复唯一静默宿主。业务宿主 39492/39686 的代次为 1、2；父进程 39386、所有捕获宿主/能力 PID 和进程组退出，准确 job `gui/501/com.loopwork.host.50858711cc4a474026e6` 已移除。这里的资源交还仅为宿主退出，不是有真实业务 Case 的修复交还。

仍未完成：desktop 从旧业务支持的适配器迁移到同一外部 root；新只读 audit 协议与尚未提供此能力的旧产物之间的兼容；真实 Admin 的准确源码修复/隔离构建/外部切换及失败回滚；未知或逃逸后代与 Windows Job containment；全部原始验收的独立重测与实际正常业务推进；三条真实模型闭环和 8–12 小时整夜验收。完整目标保持 active，不能将上述宿主/受控测试证据替代真实修复效果。

## 稳定 root 的诊断代码与跨产物健康门禁（2026-09-16）

新增独立的 root→实际不可变产物绑定，按 root owner/token 保留历史。原生 root 取得租约后先验证 bootstrap 字节，再绑定一次；同一代次不能替换。host-audit 必须使用该代码，没有绑定时在分配前失败；普通业务能力仍用持久化安装选择。停止/更新静默的只读权限不扩展为写权限，旧 owner 不能读取或变更新 owner 的绑定。实际 Node 双产物测试证明 root audit 与 business configuration 各自执行不同代码，并确认真实 PID 已退出。

首次真实切换 `/tmp/loopwork-root-capability-switch-proof.dADBiL/verify.log` 失败：候选启动后被健康门禁拒绝。原持有式模式字段误用了业务本地 mode，管理侧已经 update-silence、业务侧初始 normal 被错误拒绝；激活后该单字段反而不能证明管理屏障仍在。已分开 managementMode/businessMode/updatePending：管理屏障和当前更新必须始终有效，激活后本地业务 normal，实际 owned/fresh 监督租约、空运行、无错误不变。失败诊断包含有界判定输入，不复制 lastError 正文。失败现场和独立只读物理复查保留为 `failure-post-evidence.json`、`failure-post.log`：更新仍 rolling-back/静默，原 Case queued，全部捕获进程/组退出、租约为空；这些是退出后的事实，并未伪称保存了首次 RPC 原始包。

最终 21 项定向检查与 1100 项全量通过；standalone TypeScript、隔离 Next/Desktop runtime 构建退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/root-capability-health-{full,tsc,build,desktop}.log`。源码 `e6e4c8fe29f8f506cca47379ab0be6c8b8037678e53142728d7818a3b4e8781e`，产物 `ce2be0802c63b76e68618abd4925b574316d4cae5fa1a9ed4390cb9ecfa1f96f`。

真实双产物切换与独立只读复查 `/tmp/loopwork-root-capability-health-proof.CRkhz4/{evidence.json,verify.log,post-verify.log}` 均退出 0。旧产物 `2c63de4e73e96545482a5d592c226dff443720fc184d1ad41a39e235b31941e7` 不包含新 audit 协议，但稳定 root 的诊断 worker 正常工作；新候选使用默认私有健康 RPC，阶段依次 candidate-starting→candidate-activating→candidate-observing→succeeded，无自定义成功回调。实际候选 71439 激活/观察后，退出并交还普通新产物宿主 71628。父进程 71255、两次能力 worker 71343/71599、候选与普通宿主及 12 个真实 DB 兼容读者的 PID/组均退出，pending readers 为空，root/管理租约为空，两个不可变产物字节身份完整，候选安装选择保留，停止意图不变。

此场景零模型调用、零修复尝试，原协议测试 Case 仍 queued；普通宿主 readiness 不是实际业务推进，不是 Dev/Test 修复验收。旧已知版本不支持新 probe-update-host 的事实仍未解决为可运行的兼容方案，实际候选失败→旧已知版本健康回滚需继续做；也还需检查管理命令入口在所选产物自身受损时的独立性。desktop 接线、真实源码自动修复/独立业务验收/恢复推进、未知后代与 Windows containment、三条真实模型闭环及整夜验收未完成，完整目标保持 active。

## 旧协议健康回滚的实际打包验收（2026-09-16）

新宿主首次认证 readiness 宣告 `private-health-v1`，此后不能更改协商结果。未宣告协议的旧宿主使用稳定 root 的受管只读 worker：检查实际父宿主分配、PID/启动身份、不可变产物、业务监督 owner/代次/租约、两侧模式、当前更新及无活动运行/执行。未来未知协议拒绝降级；缺少数据库、分配或租约不能当健康。该能力与其他业务能力共用同一 broker；取消同步异常仍执行所有宿主终止，读者退出未确认则保留屏障。

23 项定向、1102 项全量测试通过；standalone TypeScript、隔离 Next/Desktop runtime 构建均退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/legacy-health-{full,tsc,build,desktop}.log`。实际源码 `975165ace40e71b4b4c5cf552c6564b06a44bd6850c6aae494530580dd80c696`，正常产物 `11baf49936e6f3e20df4816a9d044b9f5acf69611b367adac45766f10febca6f`。随后仅新增旧读者同步清理异常的契约测试，10 项原生更新测试通过，日志 `/tmp/loopwork-legacy-cleanup-targeted.log`；该新增测试不属于上述构建源码快照。

`/tmp/loopwork-real-legacy-rollback-proof.I14nJK/{evidence.json,verify.log,post-verify.log}` 均成功。在新的私有编译副本注入启动异常，生成受控坏候选 `a375350023bb5350030f61f625d06d449699353b1118e62a10c2b6cce09999de`，未改正常产物；实际旧已知版本仍为 `2c63de4e73e96545482a5d592c226dff443720fc184d1ad41a39e235b31941e7`。无自定义健康成功回调，阶段 candidate-starting→rolling-back→known-good-starting→known-good-activating→known-good-observing→rolled-back。候选 89028 退出；旧持有式宿主 89125 经实际旧协议校验、激活和观察后退出，交还普通旧宿主 89341。父进程 88756、5 个能力 worker、所有宿主与 10 个真实兼容数据库读者的 PID/进程组均在独立退出后核对中确认消失；pending-readers 为空，root/管理租约为空，安装选择保留旧版本，两份不可变产物身份完整，用户 stopped/normal 未改变。

这证明旧协议启动失败回滚与物理宿主交还，不证明真实 Admin 修改源码或原业务验收恢复。模型调用/修复尝试为 0，原 Case 仍 queued。仍需完成 desktop 共享外部 root、管理命令在选中产物受损时的独立性、真实 Harness 源码修复/构建/切换/原业务独立验证与推进、未知或逃逸后代及 Windows containment、三条真实模型闭环、8–12 小时真实整夜验收。完整目标保持 active。

## 管理工具独立性与首次进程登记失败（2026-09-16）

管理命令、工作区版本读取及独立验证 worker 改为使用当前 root 已绑定的不可变工具产物，启动前实际校验字节并检查 root/management claim/停止意图。选中的业务安装仍是环境里的调查对象，不用稳定工具版本代替原始故障版本。没有 root 绑定或工具字节改变时，在子调用前返回明确 no-spawn；下游 adapter 拒绝不能冒充 no-spawn。真实 Node 契约检查执行生产认证命令：故障业务目录中的 loop-admin.cjs 抛错不影响稳定命令，原故障仅请求验证、并未关闭。

35 项定向及 1107 项全量检查通过，独立 TypeScript、隔离 Next/Desktop 构建退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/management-tools-{full,tsc,build,desktop}.log`；源码 `cf9ebdf42325b7c6a22c57f250debefe8199417d4eb3dffc6622f5d1439178f4`，产物 `6a5d9d34d31a80e5172b32ad0a7cd4ada0b9242cded24e01dfd10b049cf4796e`。这一快照不包含随后发现的首次登记失败修复。

首次实际打包验证 `/tmp/loopwork-management-tool-proof.OKrMa4/verify.log` 失败，不能记为通过。验收脚本错误调用不存在的 bindProcess（生产 Controller 使用 attachProcess），且未启动 external service root 就尝试其 shutdown，最终异常遮蔽了早期原因；首次登记回调的异常还暴露真实底层问题：尚未取得 startMarker 时，外层 finally 的 adapter 保守拒绝终止，实际隔离 CLI 留存。准确捕获的私有父 PID 12043、CLI PID/PGID 12562，后者按已观察的实际组发送 SIGTERM 清理。`failure-post.cjs`、`failure-post.log`、`failure-post-evidence.json` 在父进程结束后只读确认父/CLI/能力 worker 和捕获进程组全部消失，停止意图保持、租约为空，原 Case 没有关闭。这是人工清理失败实验，不是自动终止成功或真实模型修复。

随后修复 invocation 准备中断的清理：POSIX 且实际创建了隔离组、没有 marker 时，只在本次捕获的 ChildProcess 仍活着的前后窗口读取实际身份并终止该组；失去根进程时只能确认实际空组，不能按复用 PID 猜测杀进程。未确认仍保留屏障；Windows 未提供 Job containment，绝不伪称覆盖。新增真实活 CLI 的首次 attach 抛错测试，断言失败详情保留、exitConfirmed=true 且 PID/组均消失。31 项 Admin/delegation 检查及独立 TypeScript 退出 0，日志 `/tmp/loopwork-attachment-failure-{targeted,tsc}.log`。最新底层修复尚需重新全量/构建，并用正确 Controller 生命周期重跑新的独立打包验收；此前失败记录不覆盖。

本轮为实际实现和验收发现问题的进展；目标未完成，仍须真实 Admin 源码修复/原业务独立验收/业务推进、desktop 共享入口、完整 containment、三条真实模型闭环与整夜验收。

## 正确 Controller 生命周期的打包复验（2026-09-16）

修复后的全量 1108 项通过、0 失败，独立 TypeScript、隔离 Next/Desktop 构建退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/attachment-cleanup-{full,tsc,build,desktop}.log`；源码 `577a848f0c4d6e23cd13f1d794bb46b8111f3f6da09e0a74e945067d25cacf65`，产物 `b96f2d0d18bc7b9826299eee7685bfce127a72f3f159d17605e0fc8fce912fed`。

首次 Controller 复验 `/tmp/loopwork-managed-tool-controller-proof.2dlACX/verify.log` 因脚本在 stopped 意图下预填 Runtime 配置而失败；该写入被生产权限门禁正确拒绝。没有修复或绕过产品门禁，改在新私有目录切换为 running 后，按实际管理所有权填入已配置的受控 CLI，再由生产 Controller 自行 claim/attach/settle。先前失败目录及日志仍保留；独立复查其 stopped、root lease 空、attempt/普通宿主数量均为 0。

新的真实打包复验 `/tmp/loopwork-managed-tool-controller-proof.wMJeFk/{evidence.json,verify.log,post-verify.log,post-evidence.json}` 成功。实际原生 service/root 在 stopped 下先启动独立 Controller，受控业务安装 `8e9b88c63c3cc2f3f68210f950de6952353f6c83acaf1bdf7527d78a188f37fa` 的命令文件在安装后故意损坏，普通宿主字节门禁拒绝 admission；改为 running 后由同一生产 Controller 使用缓存的已配置 CLI 启动 Admin。受控 Node CLI 通过生成的稳定 root 认证命令执行 status/evidence/submit-deferred；没有手工 claim、attach、finish 或代替 Controller 的人工续租。实际业务 Runtime refresh 因损坏失败的证据与 root-bound command 成功的 finding 同时保留。

父 PID 28626，Admin PID/PGID 28721，五个能力 worker 28639/28658/28671/28688/28701。Controller 保留 deferred 摘要为失败详情，原协议故障继续 queued；service shutdown 后，另一个进程只读确认所有捕获 PID/组消失，全部能力分配 exited，普通宿主数量 0（损坏候选从未获准启动）、停止意图 normal、root/management lease 空。稳定 root 产物实际字节身份完整，所选损坏产物仍校验拒绝，没有暗中修复、换目录或将其冒充稳定工具版本。

这个复验只证明生产管理控制器及命令入口能跨业务产物损坏继续调查并实际收尾进程。Node CLI 是受控协议 fixture，模型调用 0；没有真实 Admin 修源码、独立原业务验收、业务推进或 Case 关闭，不替代三条真实模型闭环和整夜验收。desktop 仍使用旧业务支持的 lifecycle 接线，迁移需要同时处理界面服务登记、停止/更新 readiness、恢复和独立诊断状态，不是直接替换 factory 名称。完整目标继续 active。

## 共享外部运行控制协议（2026-09-16）

新增 external-runtime-controls，原生独立 service 已接入 start/stop/prepare-update/resume-after-update。共享协议先提交独立管理意图或静默门禁，再并行执行 Admin、普通宿主/CLI、更新宿主/数据库读者与防休眠清理；某条路径同步异常不影响其余路径。最终确认持久化宿主/CLI/Admin/能力 worker/更新分配没有未确认退出项后才返回停止或更新就绪。失败保留意图/静默，不用数据库 logical cancellation 代替退出证明。旧请求重放、排队期间被新意图取代、跨 await 的来源检查受 revision 防护；启动 accepted 不代表原业务已经推进。

publisher 静默即使没有 RuntimeUpdate，也阻止根宿主下一次定时调度普通 host；本次模式变化同时加入普通原生启动期间的 selection guard。显式恢复才重新正常派发。外部自动更新正在进行时，普通 start/resume/publisher prepare 不能绕过其门禁；用户 stop 仍持久化停止并取消真实进程，但不伪造终态更新记录。控制器没有被 shutdown 永久关闭，后续合法请求仍可继续。

51 项定向通过，全量 1116 项通过、0 失败；standalone TypeScript、隔离 Next/Desktop 构建退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/shared-controls-{full,tsc,build,desktop}.log`；源码 `45b37e2409bead34705fe025f720741cb34790531f3185d6cfd7af8f695b16d5`，实际产物 `c9108bdd1a69736f5cf5b751a78a0eb352df3aead2631179cdfe256d5473e479`。

真实打包控制协议证据 `/tmp/loopwork-shared-control-proof.E4ufeI/{evidence.json,verify.log,post-verify.log}` 成功。父进程 45156，通过实际 native service 的 command API 准备更新，物理停止旧宿主 45222；连续三次实际 root.reconcile 都保持 updating，无新分配。start 被门禁拒绝，显式恢复创建新宿主 45281，旧 prepare 重放为 superseded 且新 PID 仍存活；随后用户 stop 物理终止新宿主。两次能力 worker 45189/45252 以及两宿主 PID/组均在父进程退出后的独立只读核对中确认消失，租约为空、stopped/normal、稳定不可变产物身份完整，无诊断异常。

这个场景用户意图始终 stopped（prepare/resume 不改意图）；zero model calls、zero attempts，原协议 Case queued，无业务修复或推进成功声明。它证明 shared native control 与实际终止/门禁，不是桌面 GUI 接线完成，也不是活跃业务/真实模型/整夜验收。下一步仍需桌面界面进程归属和状态诊断接线、发行更新目标/恢复语义，再替换旧 lifecycle；其后真实源码修复、原始验收/实际推进、containment、三条真实模型闭环及整夜验收仍是完整目标的必需项。

## 独立状态诊断与业务库损坏复验（2026-09-16）

原生 shared service 增加 status，业务生命周期只通过稳定 root-bound 的短命只读 host-audit capability 查询。返回实际意图、phase、运行时间、租约来源、重启和更新信息，不从数据库 running 推断进程健康或本宿主所有权。读取不初始化旧数据库、不迁移、不续租，缺失协议或 singleton 保持未知；不兼容 schema 显式失败。业务查询失败仍返回独立 control/宿主分配及有界错误标识，完整故障交给诊断日志；日志回调失败不遮蔽控制。状态是观测而非 readiness 或实际退出证明。

新增五项测试覆盖真实只读库、过期租约、缺失 run/singleton/协议、不兼容列、损坏 SQLite 文件与日志同时失败。全量 1121 项通过、0 失败（`/tmp/loopwork-lifecycle-status-full.log`），standalone TypeScript 退出 0，隔离 Next/Desktop 构建退出 0（`/tmp/loopwork-real-repair.fWroPo/lifecycle-status-{build,desktop}.log`）。源码 `c00a15c0f1f38507bd0d9a67ff03359555836c91651b05e3403ef54b4dc16eb8`，实际桌面产物 `fc85874bf83c21c69715fb69f40b0396d119bd92d77daca9a86cd648d0e1ff64`。

第一次实际打包脚本 `/tmp/loopwork-lifecycle-status-proof.2CSwct/verify.log` 因调用普通 Node ABI 137，而桌面 SQLite 模块绑定 Electron ABI 148，构造管理库之前即失败，无子进程启动；保留失败日志，未重新编译或替换包内模块。在新目录 `/tmp/loopwork-lifecycle-status-proof.bCHDPP` 使用实际 Electron Node 模式（Node v24.18.1、ABI 148）复验，verify/post-verify 均退出 0。真实原生宿主 65850 在 stopped 下初始化并被状态查询观察；准备更新物理退出后，故意破坏私有业务库。随后 status 返回独立 stopped/update-silence 与 BUSINESS_DIAGNOSTIC_UNAVAILABLE，完整 SQLite 故障栈保留；实际 reconcile 仍 updating，无业务宿主重启，stop 仍成功。

父进程 65803 退出后的另一进程只读核对，全部捕获宿主/能力 worker PID/组消失、分配 exited、root/management 租约为空、意图 stopped，更新静默保留，zero model attempts。证据 `evidence.json`、`verify.log`、`post-verify.log`。这是实际打包诊断/停止能力，不是修复损坏库、桌面 GUI 迁移或原业务恢复成功；当前 3000 实例未改动。完整目标仍 active，仍需桌面 UI 进程独立归属与接线、发行更新目标/恢复、真实 Admin 修复/独立原验收/业务推进、完整 containment、三条真实模型闭环及 8–12 小时整夜验收。

## 界面服务独立归属与跨代次清理（2026-09-16）

增加独立 admin_runtime_ui_processes 与唯一活动分配索引；界面服务在 spawn 前登记实际 immutable artifact/root authority/父 PID，随后只允许填入本次 PID、实际 OS start marker 与隔离组。就绪和退出匹配完整来源，迟到登记不能换 PID/组，未知无 PID 分配仍是屏障，不能靠更换 root 或 logical cancelled 消除。原生 service 提供 ui.start/stop/assertStopped，并在 status 展示独立 UI 分配。

native-runtime-ui 验证实际安装字节、在隔离 POSIX 组启动 server、写独立有界单块诊断日志，启动就绪不仅检查 HTTP，还通过异步 OS 查询确认该监听端口由实际捕获的子进程占有（前后两次确认）。已有旧服务的 HTTP 200 不算新界面启动成功。首次身份写入失败仍使用本次活 ChildProcess 读取 OS 身份并终止组；日志异常不阻止清理。未确认 actual container exit 或后续数据库写入失败时保留记录。Windows 没有真实 Job containment，不以 taskkill/child close 猜测整个树退出，仍属于未完成能力。

原生普通启动先清理前代 UI，外部更新切换清理全部当前捕获 UI；prepare-update 与 Admin 清理并行，最终更新 readiness 检查 UI 屏障。普通用户 stop Loop 保留 UI，系统 shutdown 按本 root 的实际 owner/token 捕获清理 UI；旧 root 迟到 shutdown 不能扫描并杀掉新 root 的界面。清理失败阻止外部 root 提前释放租约。清理派发及 await 返回仍校验 root/意图来源。

六项 native UI 检查通过，包括实际 HTTP listener/PID/组、复用当前实际 handle、旧服务误就绪拒绝、首次身份持久化及日志失败、未知分配保留、更新静默禁止 admission、旧 root cleanup 不杀实际 successor UI（两项场景合并在相关测试中，最终文件六项）。这是本机真实进程的受控服务器 fixture，不是真实桌面 GUI 或 Agent 任务。定向 native UI/host/control 19 项通过后增加跨代次场景；最终全量 1127 项通过、0 失败，standalone TypeScript 退出 0，隔离 Next/Desktop 构建退出 0。最终日志 `/tmp/loopwork-native-ui-owned-{full,tsc}.log` 与 `/tmp/loopwork-real-repair.fWroPo/native-ui-owned-{build,desktop}.log`；源码 `4b9e5b8f022c8d0066aead851fdfd3ce0ef7697337a3e0e85e9257c910381268`，产物 `001ee2ced382c693520368c26c8aee34ab99e70e0376c0396efe9886338f3d57`。前两轮构建/测试日志保留，不能代表后来补充的 owner-scoped shutdown 版本。

最终实际打包 shared control 复验 `/tmp/loopwork-native-ui-root-proof.3kJRmd/{evidence.json,verify.log,post-verify.log}` 成功，父 PID 22981；普通宿主 23029/23084、能力 worker 23000/23054。准备更新、三次静默 reconcile、禁止 start、显式恢复、旧请求 superseded、停止均使用真实原生协议；父进程结束后的独立只读核对确认 PID/组全消失、分配 exited、租约空、实际 root 字节完整、stopped/normal，UI 分配数 0、zero model attempts、原协议 Case queued。该复验仅回归加入 UI 归属后的打包控制路径，没有实际启动桌面 UI（当前用户要求只保留 3000 Web）。当前 3000 PID 54354、tasks HTTP 200，未重启。

desktop/main.mjs 本轮仍保留旧 createManagedLoopRunLifecycle 和 business-backed registerHostProcess，不能称为桌面迁移完成。剩余接线需要适配实际生命周期状态/控制回执、取消 Web 子进程自己的监督入口、稳定管理故障界面、发行更新目标与重启选版/恢复。之后仍必须实际 Admin 修源码、独立全部原失败/原验收/版本验证、普通业务推进、完整 containment、三条真实模型闭环与 8–12 小时整夜验收；目标继续 active。

## 桌面独立 root 接线与启动取消（2026-09-16，后续轮次）

桌面源码现已替换旧 managed lifecycle/业务进程登记，使用与 standalone 相同的 createNativeExternalService。独立管理库先于产物 staging 初始化；桌面 facade 在 service.start 前发布宿主，启动失败保留独立控制。界面从 root-bound 工具启动，授权入口验证真实安装、父 PID、分配、租约和协议标识；私有 IPC 仅开放 status/start/stop/resume，Web 不启动自己的业务监督。就绪仍须真实监听 PID 与授权确认，超时不退回本地监督。缺少协议的旧业务界面不能安全启动，使用 Electron 原生 data 页面保留停止、状态和重试控制，不把原生页面当作业务已恢复。

启动期间显式退出先在已打开的管理库持久化 stopped，然后取消 artifact 校验/staging；构造取消不能创建普通宿主或修复尝试。日志或停止回执失败不能跳过 allSettled 物理清理。状态视图不借用业务库的旧更新元数据充当独立 root 的更新目标，不从 stored running 推断 healthy。发行更新目标的独立持久化、安装后重新选版与确认恢复仍未实现，此处 null 表示未知，不是已完成更新。

上一轮最终新增测试失败日志 `/tmp/loopwork-desktop-native-construction-targeted.log` 已保留：artifact inventory 将用户取消理由遮蔽成通用错误。修复为 AbortSignal.throwIfAborted，保留同一个取消原因；默认取消仍为 AbortError，校验期限单独报 timed out。补测字节校验前与校验中的取消来源。18 项定向、全量 1136 项测试通过，0 失败；standalone TypeScript 退出 0，桌面 MJS 语法检查通过，隔离 Next/Desktop 构建退出 0。日志 `/tmp/loopwork-startup-cancellation-{targeted,full,tsc}.log`，`/tmp/loopwork-real-repair.fWroPo/startup-cancellation-{build,desktop}.log`。

实际 Electron ABI 148 的新包复验 `/tmp/loopwork-startup-cancellation-proof.zp1fbQ/{evidence.json,verify.log,post-verify.log}`，verify/post-verify 均退出 0。脚本从包内真实源码归档提取 desktop facade，复验准备更新、静默禁止 start、显式恢复、用户 stop、构造完成后但启动前退出，以及构造期间由 running 转 stopped 并取消。独立父进程后核对捕获 PID/组退出、root/management 租约为空、不可变产物内容未变。构造取消无宿主、能力 worker、Case 或模型尝试；正常协议 Case 仍 queued，零模型调用。源码 `6a6b0cfc34a47dd55a69246e218472e7f27baa9ebc474a1ce185c61b3fdb40c8`，产物 `847bf1a2f64bf5d93be2403cec67c3dc54cc0e4730ebc717fb003cd3298030a7`（本段验收文档在构建后追加，不在该源码归档内）。上一轮 d074efcf/201bde60 包的 verify/post-verify 亦成功，但不能代替本次启动取消版本。

本轮是 progress，不是目标完成。未启动额外产品 Web，主 3000 PID 54354、tasks HTTP 200、Main Loop 保持停止；没有提交、tag 或推送。真实桌面 GUI、发行安装与恢复、Admin 实际修源码与独立全原失败/验收/版本验证、物理交还后的普通业务推进、完整跨平台 containment、三条真实模型闭环和 8–12 小时真实整夜验收仍是完整目标的必需项。

## 发行更新准备持久化与安装交接（2026-09-16，后续轮次）

确认旧逻辑丢弃 desktop prepare 的 attempt/target，且新 bootstrap 不会覆盖已有持久化选择。新增独立 admin_publisher_updates，保存真实 before artifact、目标、请求/attempt、intent revision 与准备状态；保留全部历史，同一活动准备唯一。原生控制先提交准备和静默再清理，只有真实清理与全部持久化屏障通过后标记 ready；取消需先检查实际退出。重放请求先比较原动作/revision，因此旧 resume 不能取消新准备。生命周期视图读取该独立记录，不从业务旧更新元数据拼出目标。

实际新 bootstrap 校验并绑定 root 能力后，只有版本匹配、ready、意图和原选择未变，且 candidate 完整身份等于实际 root-bound artifact，才事务性创建现有 RuntimeUpdate 并标记 transitioned。选择不会在这里覆盖，继续复用持有式启动、数据兼容、健康及失败回滚。旧/错误安装保持静默；用户 stop 后废止旧准备且不恢复 running。Publisher 的更新关联键用于发行请求追踪，不表示原业务 RepairCase 已修复，也不会产生自动完成 Dev/Test 或关闭 Case 的权限。

首次定向日志 `/tmp/loopwork-publisher-targeted.log` 26/27（失败保留）：测试在静默后 reserve UI，被正常门禁拒绝，并有错误参数数量的类型检查失败；修正为先登记未知 UI 再准备，未放松产品门禁。随后 60 项定向通过、全量 1142 项通过、TypeScript 通过。最后新增 root-bound identity 校验及第七项 publisher 测试，最终 7 项 publisher 定向、全量 1143 项通过、0 失败，standalone TypeScript 与隔离 Next/Desktop 构建退出 0；日志 `/tmp/loopwork-publisher-root-binding-{targeted,full,tsc}.log`，`/tmp/loopwork-real-repair.fWroPo/publisher-root-binding-{build,desktop}.log`。前一构建/全量日志保留但不代表这项最终身份校验。

真正 Electron 桌面包控制复验 `/tmp/loopwork-publisher-control-proof.4xSoQ4/{evidence.json,verify.log,post-verify.log}`，verify/post-verify 均退出 0。包内源码归档提取 actual desktop facade，除上一轮控制/取消回归外，再执行带目标的 prepare，确认实际 target/readiness；Root shutdown 后用同一实际旧版本重新构造原生 Root，连续三次 reconcile 均 updating，无普通宿主，选择不变。显式取消恢复 accepted、旧 prepare superseded 且新宿主仍存活、用户 stop stopped。父 PID 7628 退出后的独立核对确认所有捕获进程/组消失、管理及 Root 租约为空、stopped/normal，无诊断异常。发行场景宿主 7952/8036、能力 worker 7927/7975/8011 均 exited；另外基础控制场景 PID 也在 evidence/post 中逐一检查。

源码 `9eba11a4655a408fd6870b08e1eed5a31c2f27186b48e117ad7df01f8d08ed29`，实际产物 `c7e39b1040bf3792454812ce0c273e0038ff97ae1a99aa4cc22cb98275a49cc9`（本验收段和 external-runtime-update 说明在构建后追加）。这是旧安装不会抢跑、持久化目标、取消和物理控制的实际打包证据；target 0.1.21-publisher-proof 未实际安装，匹配新版本转换仅有真实管理库契约测试，不能声称新版本安装、健康、回滚或 GUI 已验收。零模型调用、无产品 Web 监听、原协议 Case queued、未关闭业务 Case。主 3000 未改动，未提交/tag/推送；本轮 progress，完整目标 active。

后续仍须匹配新目标的真实产物切换/恢复与失败回滚、无准备记录的手动安装场景、真实桌面 GUI；以及实际 Admin 源码修复、独立全原失败/验收/版本、物理交还后的普通业务推进、完整 containment、三条真实模型闭环与 8–12 小时真实整夜验收。

## 实际匹配版本切换与回滚、跨层 ID 契约修复（2026-09-16，后续轮次）

上一轮是 progress。本轮重新读取完整目标，使用独立目录构建真正的 `0.1.21-publisher-proof` 产物，四份版本 manifest/lock 一致，主工作区仍为 0.1.20。第一次实际匹配目标证明此前静态测试不足：publisher 的 `publisher:<hash>` ID 被 host-service 的 CLI 入口拒绝，候选与已知版本都无法启动。失败日志与数据保留在 `/tmp/loopwork-publisher-target.DdFEZ8`，没有记为成功；verify 退出 1 后另一个只读进程检查全部 27 条实际宿主/更新/能力记录 exited、PID/组消失、root/management 租约空，失败事务仍保留 rolling-back。证据 `verify.log`、`failed-post-verify.log`。

修复 publisher ID 为 `publisher-<hash>`。新增 runtimeUpdateIdSchema，由新请求持久化和实际 host-service 参数入口共用；不兼容 ID 在提交更新静默之前被拒绝。历史 request 解码保持较宽，旧错误收据仍能读取诊断，不能把新请求约束直接套到历史记录导致管理入口无法读取故障。新增测试覆盖冒号、路径、空白、换行、超长 ID 无事务/静默副作用，以及真实 publisher 转换得到宿主支持的 ID。29 项定向通过，全量 1144 项通过、0 失败，Main standalone TypeScript 退出 0；日志 `/tmp/loopwork-publisher-id-{targeted,full,tsc}.log`。

新的独立候选目录 `/tmp/loopwork-publisher-target-fixed.SVDnKf/candidate` 通过版本一致性、standalone TypeScript、Next/Desktop 构建；日志在其父目录 `candidate-{build,desktop,tsc}.log`。源码 `d138f5576798a885de71c4f6c5da4486f7b0969b367c3af1cbc8d862d9117e4b`，好候选实际产物 `e384c9c7c35df1137ee60480d66157a4ea25eff837f7703f094967da5bc380bc`。坏候选只在私有编译副本的 host-service 顶部注入启动异常并重新登记实际字节身份，产物 `2e3095bb45218a1440fb02b8b4b77165dc5cecac19670f25702a2ccc1a13137b`；它不是 Admin 自主源码修复的证据，原 source archive 与受控编译故障的区别明确保留。

真实 Electron Node 模式执行 `verify.cjs`、独立父进程后执行 `post-verify.cjs`，两者退出 0；`evidence.json` 保留两个私有场景。旧 0.1.20/c7e39b10 Root 的实际 prepare/ready/shutdown 后，新目标 Root 通过实际版本及 root-bound artifact 自动创建更新：好候选依次 candidate-starting/activating/observing/succeeded，安装选择为 0.1.21-publisher-proof；坏候选真实退出码 1、错误正文保存，依次 rolling-back/known-good-starting/activating/observing/rolled-back，选择恢复 0.1.20。两者随后实际交还到所选版本的普通宿主，持有式宿主物理退出，再用用户 stop 停止全部捕获分配。

父 PID 30217 退出后的只读复验检查管理/Root 租约为空、stopped/normal、安装选择与事务终态一致、实际不可变产物完整、所有捕获 PID/组和兼容性读者退出、pending readers 空。成功场景 held 30559、普通宿主 30309/30750；回滚 held 31023/31108、普通宿主 30814/31208 均 exited；能力 worker 与读者逐条记录并验证，详见 evidence/post 日志。好候选无诊断异常，坏候选保存一次受控启动异常。

本轮改变产品代码并获得真实切换/回滚证据，属于 progress。没有发布测试版本、提交、tag、推送或额外产品 Web；主 3000/PID 54354 未重启，tasks HTTP 200，Main Loop 未启动。模型调用为 0、原协议 Case queued、repair attempts 0；普通宿主就绪不等于原业务任务已推进，不能关闭 RepairCase或宣称真实修复闭环完成。

完整目标仍 active：真实桌面 GUI/实际发行安装器及无准备手动安装、运行中不兼容旧请求的自动恢复、独立管理启动故障与 containment 边界仍需加固或验收；实际 Admin 源码修复、独立全部原失败/原验收/实际修复版本、正常业务推进、三条真实模型闭环和 8–12 小时真实整夜运行仍缺最终证据。

## 安装字节损坏时的独立缓存启动（2026-09-16，后续轮次）

原生 service 在打开独立管理库后，先校验当前安装并 staging；失败时只使用管理库中此前实际 Root 绑定过的内容寻址快照，不扫描任意缓存目录。候选必须重新验证全部实际字节、无软链接逃逸、路径及完整 artifact 身份；按不同快照去重后取最近八个，损坏的新快照反复绑定不能挤掉旧可用快照。坏 JSON 和诊断回调抛错不遮蔽后续有效候选。原始安装错误归一化为独立 queued RepairCase，重复观察幂等；没有任何有效快照仍持久化故障再拒绝构造。用户取消保留原始 abort reason，不转成安装故障。

生命周期状态暴露 bootstrapWarning/BOOTSTRAP_UNAVAILABLE，缓存启动不是原安装已恢复，也不把 stopped 或缓存摘要当作业务健康。七项真实字节/独立管理库检查覆盖有效安装优先、损坏安装、缓存也损坏、错误路径、软链接逃逸、损坏历史 JSON、重复最近绑定，以及取消和抛错诊断。公共 artifact fixture 独立于测试注册；首次全量检查暴露夹具父目录顺序依赖，失败日志 `/tmp/loopwork-native-bootstrap-{full,view-full}.log` 保留，改为 recursive mkdir 后最终独立定向 21 项通过。

最终全量 1151 项通过、0 失败（`/tmp/loopwork-native-bootstrap-independent-full.log`），standalone TypeScript 再确认退出 0（`/tmp/loopwork-native-bootstrap-final-confirm-tsc.log`），隔离 Next/Desktop 构建退出 0（`/tmp/loopwork-real-repair.fWroPo/native-bootstrap-independent-{build,desktop}.log`）。源码 `0e11f7345fc2c5bbd19c17e9d64129a53e196697bac4d1035b0e39d3db8fc65c`、实际产物 `96f022249af4acfaac37a12b445c0ac9f70b6a69d0275c467f9226b08eccb20b`，主工作区版本未改变，本段文档在构建后追加。

实际 Electron Node 模式执行 `/tmp/loopwork-bootstrap-cache-proof.wMxyv9/{verify.cjs,post-verify.cjs}`，两者退出 0，`evidence.json`/对应日志保留。先实际启动并绑定完好缓存，再只修改私有安装副本的 host-service 编译字节而不重签 manifest；损坏安装确实被校验拒绝，原生构造使用原绑定缓存，实际 status、prepare/readiness、两次更新静默、禁止 start、显式恢复与 stop 均成功。无缓存的新私有管理库保存 queued 故障且构造失败，没有普通宿主或修复尝试。父 PID 91076 退出后的独立只读核对确认三个普通宿主 91140/91202/91304、五个能力 worker 91112/91173/91215/91244/91279 和实际组全部消失，Root/management 租约空，stopped，Case queued、attempts 0、UI 分配 0。缓存字节仍完整，损坏原安装仍校验失败；抛错诊断回调未阻断恢复控制。

这属于进展，不是目标完成：未注入 external-runtime 模块本身加载失败，桌面当前 require 发生在原生构造前，该边界仍未解决；缓存 native ABI 与新 Electron 的兼容未证明。零模型调用、无产品 Web 监听、无真实 GUI、没有修复或关闭原业务 Case。主 3000/PID 54354 未重启，tasks HTTP 200，未启动主 Loop、提交/tag/推送。后续必须实际 Admin 调查并修源码、独立全部原失败/原验收/实际修复版本、物理交还后普通业务推进；三条真实模型闭环、8–12 小时整夜验收和其余完整目标仍保持必需。

## 历史更新请求兼容恢复与快照重取样（2026-09-16，后续轮次）

历史 host-incompatible ID 仍可解码，但之前实际候选/回滚 CLI 都不能启动。现在由独立更新 Controller 在启动前识别：先实际 drain、验证已知版本对当前真实数据的可读性，再确认读者/写入者退出；管理库再次检查全部宿主、CLI、UI、持有式分配、业务能力和 Admin 屏障。旧事务保留原请求、原 ID、原错误，追加重发关联事件；同一事务中终结旧请求并创建合法 recovery-<hash> 新请求，沿用原 Case 和全部版本身份，没有普通派发窗口。未知退出、兼容性拒绝、陈旧所有权、停止意图和替代请求持久化失败不能解除静默或重发。SQLite 触发器故障检查证明旧事务/安装选择/意图 revision 同时回滚。不是删除历史或改写业务完成状态。

第一次实际 Electron 复验 `/tmp/loopwork-legacy-update-proof.L2AVvB/verify.log` 退出 1，保留现场：旧请求重发成功，但候选观察阶段的真实数据写入令在线副本失效，原逻辑将其当作不兼容转入 rolling-back。只有 data_version 证据，未用写入源追踪证明具体哪个后台续租操作；不能将所有数据变化解释为无害心跳。父 PID 11398 结束后的 `failed-post-verify.cjs` 退出 0，独立只读核对全部捕获进程/组、13 个兼容读者消失，租约空、stopped、事务仍 rolling-back、零模型尝试，未抹掉失败。

增加明确的 RuntimeCompatibilityResample 事实。在线备份后源 data_version/文件身份变化或出现新数据库仍拒绝旧副本，不产生 passed 收据；Controller 保持原 guarded phase，持久化重取样事件，下轮重新完整验证，不据此误回滚健康候选。真实结构/原数据变换/迁移历史破坏/读者不兼容仍按原门禁拒绝并回滚；取消和清理失败优先。定向检查覆盖全部八个非终态阶段、实际 WAL 写入后重新完整读取新副本且不还原旧数据、停止与失效同时发生、旧请求重发的持久化原子性和未知分配。首次测试夹具外键顺序与静默后分配普通宿主的失败日志保留，修正夹具没有放松产品门禁。

最终 32 项定向通过、全量 1157 项通过、0 失败（`/tmp/loopwork-update-resample-{targeted,full}.log`），standalone TypeScript 退出 0（`/tmp/loopwork-update-resample-tsc.log`），隔离 Next/Desktop 构建退出 0（`/tmp/loopwork-real-repair.fWroPo/update-resample-{build,desktop}.log`）。源码 `7b61ee52d736bbe6f7796dc884fb000ce2f536d61c073425e654a0ffea6ca9f4`，实际产物 `abff20678c68a1083d5ddbcfe36b0845a5efc5a125adbb3bccf758017b76c881`。前一仅重发版本的 1155 项与 b649042d 产物不能代表新增重取样处理。本段在构建后追加。

修正后 `/tmp/loopwork-legacy-update-resample-proof.CXW2Dx/{verify.cjs,post-verify.cjs}` 实际 Electron 执行均退出 0，证据 `evidence.json`/对应日志。旧 publisher:<uuid> 原请求和错误原样保存，原生宿主重发合法新事务；实际阶段 candidate-starting/activating/observing，发生一次真实副本失效后仍 observing，再完整重验 succeeded，选择实际 `0.1.21-publisher-proof`/e384c9c7 产物。随后所选版本普通宿主在 stopped 下启动，再停止和 shutdown。父 PID 31825 结束后的独立只读复查确认普通宿主 31910/32519、持有式宿主 32260、能力 worker 31864/31961/32032/32157/32488 及实际组、16 个兼容数据库读者均消失，pending readers 空，Root/management 租约空，stopped/normal，原始及候选实际字节完整。

这轮是修复两条真实恢复路径并取得实际进程证据的 progress。它仍是受控历史请求/产物切换：零模型调用、没有业务 RepairCase 修复或关闭、普通宿主就绪不是业务推进、没有真实 GUI 或实际发行安装器。未启动额外产品 Web、主 Loop、提交/tag/推送；主 3000/PID 54354 未重启，tasks HTTP 200。已读 loopwork-smoke-walkthrough，真正业务验收必须通过隔离 UI 的配置/创建/启动入口，不能用直接改库补业务成功；临时同端口替换 3000 的许可仍待用户确认。完整目标继续 active，实际 Admin 源码修复/全部独立原失败与验收/修复版本/物理交还及业务推进、三个真实模型场景、8–12 小时整夜和独立入口加载/containment 等缺口仍需完成。

## 独立 Harness 源码动作及实际包复验（2026-09-16，后续轮次）

完整目标重新读取；前一目标轮次属于 progress。发现 runtime Case 没有业务工作项时，原管理动作仍只能接管业务工作区。新增 `loop-admin harness workspace`，复用当前命令身份、status-first、代次、意图与幂等协议，仅接受当前 Case 原始 runtime observation。源码还原由 Root-bound 原生能力子进程执行，入口先验证独立授权再加载还原模块，不导入业务库，也不运行损坏的业务镜像。原始内容寻址路径、归档整体源码身份、版本和实际 Build ID 校验后，创建独立新目录；停机、失权或终止提交阻止迟到写入和完成记录，部分目录保留。该动作不替代业务接管锚点，不能解除独立业务验收门禁。

六项新增测试覆盖身份与参数、故障执行字节但准确源码、外来归档及输入/输出软链接、途中停止、终止提交后仍排队的请求，以及两套真实损坏数据库下的独立原生子进程。最后一项稳定 Root 镜像与故障所选镜像不同，核对还原的是原始故障源码、不是当前管理镜像源码，且能力调用返回前实际 PID/组已消失。最终全量 1163 项通过、0 失败（`/tmp/loopwork-admin-harness-workspace-full.log`），standalone TypeScript 退出 0（`/tmp/loopwork-admin-harness-workspace-final-confirm-tsc.log`），隔离 Next/Desktop 构建退出 0（`/tmp/loopwork-real-repair.fWroPo/admin-harness-workspace-{build,desktop}.log`）。修复前的两份类型错误日志保留，未作为通过证据。

真正 Electron ABI 148 的当前桌面包执行 `/tmp/loopwork-admin-harness-source-proof.shGvil/{verify.cjs,post-verify.cjs}` 均退出 0，证据及日志保留。实际打包 CLI 完成 status-first、请求、状态读取；稳定 Root 能力子进程从私有损坏镜像还原旧版本准确源码，两套实际业务数据库损坏不阻断。新包源码 `ca172ba21df43caf2819c8ef989cfaeaf6aa0e8dcd1d4a67e59255b15ac1ae67`，产物 `b8cbcaffb58e1cf6745a5ab75ce0a2c7389dd94c714a24c5ae36d0ed13697a19`，版本仍 0.1.20；实际还原旧原始故障源码 `9eba11a4655a408fd6870b08e1eed5a31c2f27186b48e117ad7df01f8d08ed29`，不是新 Root 的源码。父 PID 54526 退出后的独立只读核对确认能力 worker 54549/PID 与进程组消失、Root/管理租约空、stopped、原 Case queued。故障执行字节仍被真实完整性检查拒绝，两套数据库原故障字节未变。验收说明在构建后追加，不在该源码归档内。

此处受控调查 claim 明确没有启动模型 CLI；其失败终止仅用于回收这次协议验收，不宣称真实 Admin 调查。`prepared` 不是修复成功、验证通过、更新授权或业务完成。完整目标保持 active：仍须接通 runtime 来源的独立验证与候选更新交接、实际 Admin 修源码及全部原失败/验收/修复版本验证、物理交还后业务推进；真实 GUI、三个模型闭环、8–12 小时整夜与启动入口加载/ABI/containment 等仍未完成。未启动额外 Web 或主 Loop；3000/PID 54354 未重启，未提交/tag/推送。

## 原始运行故障到源码动作的真实接线修复（2026-09-16，后续轮次）

继续审计发现上述受控协议证据没有覆盖真实 reporter：普通宿主失败保存 attemptedArtifact，而源码动作读取 artifact；独立能力调用失败原本没有保存执行镜像身份。新增纯领域 originalRuntimeArtifact，读取当前规范字段与历史 attemptedArtifact，双字段不同、非法主字段或只有 managementBootstrap 均拒绝，不改写旧记录，也不猜测当前安装。实际宿主 reporter 同时保存规范字段和原审计字段；validation 失败仍标记身份未验证，源码还原仍执行原完整归档/路径/Build ID 门禁。

原生能力调用在执行前捕获产物、安装 revision 和运行意图 revision，失败原因包含该原始身份并保留 cause；物理退出失败仍保留原屏障。管理 reporter 使用捕获来源，旧调用在停止/重启之后返回不会被算成新故障。新增测试经真实宿主 reporter、历史原记录和实际原生能力失败进入源码命令，确认还原原故障镜像而非管理 Root，保留历史；另测实际 hung 子进程手动停止并重启后旧错误不能创建 Case，PID 已退出。成功响应之后的高层配置解析错误尚未携带这种执行来源，不将此项称为所有能力故障路径已覆盖。

最终全量 1168 项通过、0 失败（/tmp/loopwork-original-artifact-intent-full.log），standalone TypeScript 退出 0（/tmp/loopwork-original-artifact-intent-tsc.log），隔离 Next/Desktop 构建退出 0（/tmp/loopwork-real-repair.fWroPo/original-artifact-intent-{build,desktop}.log）。源码 5979712d2fb89191145d2fe6e026172e46dde3d20855bf9f5fde6ef4d54c73d7，产物 97b8ec1b4912eb740a1733f003f836adb00054c68ddfe4ec70bbc4bcab8a7829，仍 0.1.20。较早 1167 项/意图捕获前的构建不代表最终版本，初次测试 API/类型夹具错误日志保留；当前包未另作完整打包协议复验，不借用上段旧包证明新包修复闭环。本段构建后追加。

这是修复实际接线的 progress；完整目标仍 active，候选构建、runtime 独立验证/交接、真实 Admin 代码修复与全部原目标验证、业务推进、真实模型三场景与整夜等要求没有缩减。3000/PID 54354 未重启、未启动主 Loop 或额外 Web、无提交/tag/推送。

## 受管理的真实候选构建与测试环境修复（2026-09-16，后续轮次）

上一轮是 progress，本轮完整目标重读。新增 `loop-admin harness build --key ... --workspace-key ... --reason ...`，复用当前身份、status-first、幂等和代次；仅接受本轮已完成准确源码动作。宿主重新核对原始 artifact、本轮授权和私有实际目录，冻结实际修改后源码，在新目录依次安装 lock 依赖、完整测试、独立 TypeScript、Next/Desktop 构建；记录阶段收据、日志，构建前后校验源码及最终产物身份并导入内容寻址缓存。部分目录、失败日志保留；成功只表示 candidate-built，禁止自动选择版本、完成 Dev/Test 或关闭 Case。

使用相同原生能力协议和物理退出机制，新增独立 admin_harness_build_processes，不删除或放宽旧业务能力表的唯一索引。管理只允许同 Root/监督代次/意图且实际身份已确认的跨通道并行；未知分配、旧代次、源码授权失效仍阻断。短诊断和长构建使用分别绑定的队列，长构建最多 20 分钟，停止/更新/前代清理覆盖两条实际进程通道。Root 读取两个账本；旧请求和旧业务能力账本保留。

第一次实际包验收 `/tmp/loopwork-native-harness-build-proof.zXgC14` 暴露真实测试环境缺陷：编译环境的 LOOP_GLOBAL_DB_PATH 在并行测试进程重新创建 LOOP_DATA_ROOT 后仍继承，测试共享编译数据库而出现大量失败。没有接受这次运行或候选；通过实际独立管理 API 停止该私有意图。原 verify 退出 1，日志、build.log 与 abort-evidence.json 保留。之后独立 failed-post-verify 退出 0，确认父 PID 18219、三个 worker/组 18232/18263/18271 与停止前捕获的 6 个进程消失，Root/管理租约空、stopped；按冻结源码路径额外检查未见残留宿主。受控且从未启动 CLI 的逻辑 claim 留在 launching/pid=null，明确记为未结算，而非真实 Admin 失败或成功；不能据此称整个协议已完成。首次 failed-post 查询用了错误 SQLite 字面量，失败日志亦保留，修正后重核对。

新增 harnessTestEnvironment，测试阶段清除编译/管理 LOOP 配置与 Node 注入；测试 setup 同时清除父进程的显式数据库和工作区覆盖。两个真实 preloaded 测试子进程证明数据根各自不同，原数据库覆盖在业务导入前已清除。其余新增测试覆盖命令准入、实际依赖失败/完整错误日志、真实长 subprocess 失权退出、已绑定构建与短诊断并行、两通道停止及未知构建分配。初次并行检查在第二条通道身份尚未知时要求停止成功，被原严格退出门禁拒绝；修正测试等待实际身份后再测试双绑定停止，没有放松未知退出处理。

最终全量 1175 项通过、0 失败（/tmp/loopwork-admin-harness-build-final-confirm-full.log），standalone TypeScript 退出 0（/tmp/loopwork-admin-harness-build-final-confirm-tsc.log），隔离 Next/Desktop 构建退出 0（/tmp/loopwork-real-repair.fWroPo/admin-harness-build-final-confirm-{next,desktop}.log）。源码 fc096ffc61f9f0a10832d6ac9581c8537c56158737ec65837491e2d6095a9b47，实际产物 28af8b75770212af4736e87113d69914ac52d8d8d81909e7ced8e7728fab939d，仍 0.1.20。早期 1173/1174 项及类型错误版本不代表最终 source；验收文档构建后追加。

修正后 `/tmp/loopwork-native-harness-build-fixed.OJKpkY/{verify.cjs,post-verify.cjs}` 由真实 Electron ABI 148 执行，均退出 0。实际打包管理命令请求、独立 Root-bound source/build 能力完成整条真实工具链：npm ci、原故障版本完整 1143 项测试/0 失败、tsc、Next/Desktop 构建。生成实际候选 cf30a6a73d9c9f23fa0a1ae873d5ad4cf070f56383076499afe31ecd3e8fd501，准确旧源码仍为 9eba11a4655a408fd6870b08e1eed5a31c2f27186b48e117ad7df01f8d08ed29，没有改成当前管理镜像源码。故障所选镜像编译字节仍损坏、两套数据库仍损坏；并行短诊断 1071ms 返回实际 SQLite 故障，构建进程当时仍存活。父 PID 80445 结束后的独立只读核对确认 source/build/audit worker 80450/80481/80489、组全部消失，租约空，stopped，Case queued，故障数据及原源码未被替换，候选和管理镜像字节完整。

这是受控编译链，不是实际模型 Admin 修改源码；零真实模型调用、没有版本切换、runtime 原故障独立验收或业务推进。完整目标仍 active：下一步必须接通 runtime 原始来源/目标的独立验证与更新交接；本次编译验收的原安装字节损坏不能由既有 intact-before 切换验收证明，仍需可信回滚来源。另有真实 Admin 修复及全部原始目标/实际执行版本验证、物理交还后业务推进、入口加载/ABI/containment、真实 GUI、三模型场景与 8–12 小时整夜要求，均未缩减。3000/PID 54354 未重启，无主 Loop 或额外产品 Web、无提交/tag/推送。

## 原安装损坏的历史回滚与真实激活门禁修复（2026-09-16，后续轮次）

上一目标轮是 progress。本轮重读完整目标后新增历史回滚来源：原安装仍保存为 request.before，另表保存本次固定目标及原历史更新 ID。来源必须是不同实际目录、已成功或成功回滚事务及匹配持有式进程/身份/激活记录，再由原生外部控制器重新核对完整字节；新候选和稳定管理 bootstrap 本身不是已知可用证明。没有历史来源时保留静默和退出屏障，不猜测目录。候选及回滚重新执行固定目标的实际数据库读者，并保留原安装和回滚目标两边的已执行 SQL 约束、原始在线数据投影、后续升级可读性及实际版本健康门禁。回滚来源不改原请求严格 JSON 协议；只有新的外部控制器解释新增侧表，不声称旧外部控制器已经支持此能力。

定向 36 项、之后含新增生产读者覆盖的全量 1178 项先通过，但实际安装包 /tmp/loopwork-installed-historical-rollback.ZhGYVc/verify.cjs 暴露另一处遗留：runtime-supervision 激活仍比较 pending.request.before，从而拒绝历史目标。没有接受这次运行；通过实际私有管理入口保存停止意图，verify 退出 1，日志与原记录保留。failed-post-verify 另进程退出 0，确认父 PID 26063、所有记录的普通/持有宿主和能力进程及进程组消失，管理/Root 租约空、用户 stopped、零 Admin/model 尝试及零已关闭 Case。更新没有被伪造为成功回滚。

随后修复真实宿主激活入口，统一调用 runtimeActivationTarget；纯门禁回归覆盖历史目标、旧协议 intact-before 回退及不允许激活的阶段。新增实际生产数据库读者测试确认原 reader 字节损坏时运行历史目标、收据保留原身份、原 BLOB/数据不变；原安装的已执行 SQL 改动仍被拒绝，没有把历史目标作为豁免。

最终全量 1179 项通过、0 失败（/tmp/loopwork-historical-rollback-final-confirm-full.log），独立 TypeScript 退出 0（/tmp/loopwork-historical-rollback-final-confirm2-tsc.log）；隔离 Next/Desktop 构建退出 0（/tmp/loopwork-real-repair.fWroPo/historical-rollback-final-{next,desktop}.log）。源码 b830b44b73e7a66e7e8b0330cbcaa14a9753970bc1382e1d66db8a7fa9848644，实际产物 02b1793a2f0529ea12db231be8ec4a67c164dbbc6525394cfbe2d480682a05cc，版本仍 0.1.20。本验收文档构建后追加，不在该源码归档内。

修正后的真实安装包验收 /tmp/loopwork-installed-historical-rollback-fixed.Vzq3RW/{verify.cjs,post-verify.cjs} 均由实际 Electron ABI 148 执行并退出 0。通过两次真实持有式启动与普通交接建立历史来源，然后损坏当前所选 28af... 产物的实际入口，令另一个实际候选入口启动退出 1。自动选取已真实启动的 02b179... 目标、固定其来源更新 ID，经实际生产数据库读者检查、物理排空、实际版本激活/健康、普通宿主交还完成回滚。共 14 个实际兼容收据，其中 6 个使用并保存历史目标及原损坏安装；未运行模拟的兼容端口或自定义健康绕过。父 PID 67133 退出后的独立 post-verify 重读 SQLite、实际产物/损坏原字节、读者和两类宿主账本及进程组，确认捕获普通宿主 67519/67908/68268、持有宿主 67296/67680/68101/68185、七个能力 worker、各实际读者及其组全部退出，租约空、stopped/normal、零模型尝试、零已关闭 Case。日志/evidence.json 与首轮失败记录均保留。

本部分只证明受控回滚协议，不是 Admin 自主修复源码或原业务恢复。完整目标仍包含真实模型 Admin 实际修改、runtime 原始目标独立验证、实际业务恢复推进、三条真实业务闭环及 8–12 小时整夜验收，均未减项。下一轮重点是将准确源码/实际候选、原始 runtime 目标独立验证、外部切换与普通业务推进串成同一受门禁闭环，不能把本次 boot/rollback 健康当作 Case 关闭依据。未提交/tag/推送，3000/PID 54354 保持不变。

## Runtime 原始目标独立验证与受保护外部切换入口（2026-09-16，后续轮次）

上一目标轮完成真实历史回滚证明，属于 progress。本轮重读完整目标，补充与业务工作区分开的 runtime 独立输入。宿主绑定原故障准确源码、本轮完整五阶段构建动作、实际候选 artifactId、冻结源码路径及管理代次；不能使用应用版本号、自拟身份或修复者的检查作为验证授权。全部原始 runtime 故障事实均保留；混合业务原目标仍必须完整覆盖原验收。旧业务输入默认形态和既有来源散列不重写。

稳定 Root-bound 原生只读能力重新检查私有目录、无路径别名、构建物理退出、冻结源码及候选真实字节，在两套真实业务数据库均损坏时仍可工作。生产默认阶段选择器先由独立物理进程准备冻结检查，再由另一个验证进程实际执行候选编译入口；运行目录是候选，数据目录按物理验证 attempt 隔离，清除继承的 LOOP 数据库/运行意图覆盖。实际编译产物身份 CLI 前后读取真实字节，拒绝与宿主绑定身份不一致的描述；准备、构建和 boot 均不是通过结论。

前阶段最终全量 1184 项/0 失败，独立 TypeScript 及隔离 Next/Desktop 构建通过，日志为 `/tmp/loopwork-runtime-independent-final-full.log`、`/tmp/loopwork-runtime-independent-final-confirm-tsc.log`、`/tmp/loopwork-real-repair.fWroPo/runtime-independent-final-{next,desktop}.log`。源码 607f126af2e6c3355b99664bfca76d25e3eaa6f75d8bc5ebc6795fa6115360e5，产物 09a23e77eb2c49966b1f5ad4e459541a1482d15285110ba0d767d37f760acc89，仍 0.1.20。实际 Electron ABI 148 执行 `/tmp/loopwork-runtime-version-packaged.chG6Xa/{verify.cjs,post-verify.cjs}` 均退出 0：读取此前真实编译的旧候选 cf30... 的实际身份，伪造源码身份退出 1、无虚假版本输出。独立 post 确认父 PID 19090 及 CLI PID/组 19097、19098 已消失，验证时两边实际字节不变。此证明只覆盖打包身份协议；后续构建会替换隔离输出目录，不声称该可变构建输出仍指向旧包。

继续接入原生管理宿主：只有 observing 的当前 repair-verification 全原始覆盖收据、实际退出的管理进程、当前原安装和候选构建来源一致，才可在 native 冻结源码/实际字节复查后原子提交确定性外部更新请求。切换请求进入静默，不依赖即将被替换的业务 Runner。其他管理/能力进程仍活着或身份未知时不能请求。终止请求不会被重复提交；回滚留下新的原始外部失败目标并返回调查。中止保存中性取消证据，不作为新原始失败或错误预算；用户 stopped 时禁止继续，用户重新启动后才可恢复未完成调查。

新增测试明确区分证据：源码/五阶段构建完成元数据是受控 admission fixture，不代表这六项测试真正运行了 npm/编译或真实模型修源码；默认阶段选择、候选响应断言、隔离数据、源身份 CLI、能力子进程及其实际退出是物理执行。额外受控实际子进程验证切换前能力退出屏障。aborted/rolled-back 管理终止状态是显式受控元数据，不冒充真实外部启动/回滚证明。入口仍不生成物理 runtime 交还收据，不关闭 Case，不完成 Dev/Test。

最终审计额外确认：原始 observation ID 齐全不等于原始验收检查齐全。切换入口重新按宿主原始事实授权全部 targetRef；定向测试对收据读取端注入“保留 passed 与全部 ID、截断验收检查”的受控异常，确认拒绝更新，再恢复真正物理验证收据。没有持久化伪通过结果或放宽门禁。

最终当前实现全量 1185 项/0 失败（`/tmp/loopwork-runtime-update-admission-coverage-full.log`），6 项最终定向回归通过（`/tmp/loopwork-runtime-update-admission-coverage-final-targeted.log`），独立 TypeScript 退出 0（`/tmp/loopwork-runtime-update-admission-coverage-final-tsc.log`）。隔离 Next/Desktop 构建均退出 0（`/tmp/loopwork-runtime-update-admission-coverage-{next,desktop}.log`），实际源码 a82299be11c506abb035b3f4beac9b957a9e5d3d4c065539418855da06051929、产物 e0fc1328003e3477befde12f476f10638110319673b5fcec91aeb96ecf71b92b，版本仍 0.1.20。较早的本轮构建不作为这一最终源码的证据。

最终包的实际 Electron ABI 148 身份协议再次由 `/tmp/loopwork-runtime-update-packaged.ZHtxYh/{verify.cjs,post-verify.cjs}` 执行，两者退出 0。独立 post 在父 PID 223 退出后重读实际新包与旧候选字节，确认 CLI PID/组 228、229 消失；正确候选返回实际 artifactId，伪造源身份退出 1 且无虚假输出。零真实模型调用；只证明最终打包身份协议，不冒充候选切换、原始业务恢复或自主源码修复。

剩余目标保持完整：runtime 切换后普通宿主物理交还与原业务新执行推进/关闭 Case 路径、非 Harness 环境故障的现有镜像验证、构建前 runtime 独立诊断、旧轮候选复用、实际 Admin 修源码和全部原始目标验证、启动入口加载/ABI/Windows containment、真实 GUI、三条真实模型闭环及 8–12 小时整夜验收。尚未完成这些要求，不能宣称全自动自修复已经完成。未提交/tag/推送，主 Loop 未启动，3000/PID 54354 未重启。此实施记录在候选源码捕获之后追加，最终验收段落不在已绑定的构建源码归档内。

## Runtime 物理交还代次与后续失败预算（2026-09-16，后续轮次）

上一目标轮接通受保护候选请求，属于 progress。本轮重读完整目标，将切换前的旧普通宿主／活动 CLI／更新分配与宿主序号在同一管理事务保存。交还要求实际安装仍是本次成功切换候选、新普通宿主序号在基线之后、实际 PID／启动 marker／独立进程组、业务监督代次和 CLI 协议认证。尚无新 ready 普通宿主时等待；旧分配或身份未知不能当作已交还。独立 Root 重新读冻结源码和候选字节，核对被捕获的旧宿主、更新进程和脱离宿主组 CLI 的实际组消失，以及新宿主当前身份。它不杀不明进程，不导入业务库，不完成 Dev/Test。

同一物理宿主交还幂等，正常宿主退出并更换时追加新代次，旧证据不可改写，管理重开可读完整历史。已保存的早期单条收据不删除或改写，新增代次侧表保留后续 custody。真实校验失败保存实际候选来源、前次交还及错误并重新排队调查，不再只在日志报错后永久 observing。切换回滚和交还失败保存宿主归一化 recoveryFailureId，恢复策略消费不同修复周期的持久化身份；重复同一事实、中性取消不重复扣预算，通过的独立验证仍保留 passed=true，不篡改成失败 execution。

7 项最终定向测试通过（`/tmp/loopwork-runtime-handoff-budget-targeted.log`），独立 TypeScript 退出 0（`/tmp/loopwork-runtime-handoff-budget-tsc.log`），最新全量 1186 项/0 失败（`/tmp/loopwork-runtime-handoff-budget-full.log`），隔离 Next 构建退出 0（`/tmp/loopwork-runtime-handoff-budget-next.log`）。测试范围必须明确：独立准备/候选响应检查实际执行；构建收据与外部 succeeded/aborted/rolled-back 阶段是受控元数据，不是实际编译或外部切换证明。正向物理交还运行实际候选 fixture 编译入口，真实子进程自认证 CLI 协议，但业务监督 token 是受控值，没有产品业务 DB 或真实模型调用。旧宿主假 exited 的对抗状态被实际存活的旧进程组拒绝；随后实际终止、确认组消失才保存收据。真实 fixture 宿主退出和另一个 fixture 宿主启动产生两个不可覆盖的代次；管理重开保留证据。实际候选文件字节损坏被拒绝并保存失败，修复周期预算继续，已通过的 fixture 独立验证收据状态没有被伪造。

用于查看预算的额外 investigation claim 明确没有交给 launcher；受控 no-spawn 终止不宣称真实 Admin 调查。所有 fixture 宿主/组结束时实际退出，候选原字节恢复；在 fixture 管理重开及结束前断言中核对原始失败、两代交还及后来失败完整。全局测试夹具按自身规则回收临时库，不宣称这些临时库是生产记录或额外持久化验收产物。POSIX 定向验证不等于 Windows 原生容器验证；Windows 无原生证据不自动通过。

最终隔离桌面构建也退出 0（`/tmp/loopwork-runtime-handoff-budget-desktop.log`），源码 10e594635d08dd0b4662108db930bf6d43e77d468148c6cef2ff4717be3182de、实际产物 a459abe93a4ab336cb14f16e34996b9c706cc80867ff7fdd8b432fe9aca3705b，版本仍 0.1.20。实际 Electron ABI 148 运行 `/tmp/loopwork-runtime-handoff-packaged.FM0k8j/{verify.cjs,post-verify.cjs}` 均退出 0；独立 post 在父 PID 46104 结束后重读最终包和此前真正编译的 cf30... 候选实际字节，确认身份 CLI PID/组 46117、46118 已消失。正确描述返回实际身份，假源码描述退出 1 且无虚假输出。零模型调用，只证明最终包身份 CLI；不是打包宿主交还、原任务推进或真实自动修复的替代。

完整目标仍 active：下一步需将交还代次与原业务执行的实际候选版本、CLI 来源、结果应用、原工作项推进和关闭 Case 串起来。物理交还不能代替原业务已经恢复；仍有非 Harness/构建前 runtime 诊断、旧候选续用、实际 Admin 修改源码和全部原始目标验证、入口/ABI/containment、真实 GUI、三条真实模型闭环及 8–12 小时整夜要求。未提交/tag/推送，未启动主 Loop 或额外产品 Web，3000/PID 54354 未重启。本验收文档在最终源码捕获之后追加，后续证据段落不属于已绑定源码归档。

## 原业务推进只读核心（目标继续，2026-09-16）

上一目标轮完成物理交还/代次/失败预算和实际身份 CLI 证据，是 progress；随后用户询问工作区状态，仅作只读 Git 检查，没有清理或提交。本轮重读完整目标后新增 `runtime-business-progress` domain/application/test：实际只读连接冻结原始时间范围的工作项、revision、epoch 和已存在执行，绑定完整候选版本以及 Case/verification/update。更新静默和物理退出由调用方在一致性读取前后提供实际证明；这一步尚未接到产品的外部控制器，不能宣称已自动冻结。故障后取消/替代原工作项不能从基线中抹掉该原需求。损坏 schema、非法时间不伪造空任务集。

观察器只返回 candidate：普通完成事件、当前 epoch、实际 applied execution 和 applied/advanced result 缺一不可；旧提交/旧执行、无关新需求、仲裁或人工完成、暂停、删除、未解决介入、活动 execution 进程均不通过。每条原需求有一次正常推进即可；同一更新下实际交还的不同宿主各自保留执行/CLI 来源，完整候选身份不能变。CLI 的 ledger exited 不是原生物理退出证明，后续管理边界仍必须重新核对真实容器/进程和实际候选字节。没有实现或开放任何直接完成 Dev/Test 或关闭 Case 的捷径。

新增 8 项测试，其中 7 项为明确标注的受控 SQL/交还/CLI provenance fixture，另一项使用实际迁移库和普通 direct 命令：只保存 submit 时观察为空，经现有 applyAgentResult/completeExecution 实际执行后读取到真实 complete event/result/execution；重读不重复应用。此项仍使用受控 CLI/宿主来源，不是真实 Agent 或产品宿主闭环。最终定向 39 项通过；最终全量 1194 项通过（`/tmp/loopwork-runtime-business-progress-full-final.log`，81377ms，退出 0）。首次 standalone TypeScript 暴露测试 get() 的类型错误，修正后再次独立 `tsc --noEmit` 退出 0，没有用 transpile-only 测试替代类型检查。

隔离构建位于 `/tmp/loopwork-runtime-business-progress-build.HUmenW`。首次依赖软链接越过 Turbopack root 而退出 1（`/tmp/loopwork-runtime-business-progress-next.log`）；删除的只是本次临时构建目录里已核实指向主 node_modules 的软链接，未删除依赖本体，改成实际复制依赖后重新构建 Next 退出 0（`/tmp/loopwork-runtime-business-progress-next-recheck.log`），桌面构建退出 0（`/tmp/loopwork-runtime-business-progress-desktop.log`）。冻结源码 cb1b1604282f0519cbc31b9a7e4205853c37462456bbe0dca9273cb28baa1e3c、产物 848cddb48d0ced4cd1a6e68b16a1f876aa28c4db2bd937ebe1d7d99e4442f41e、版本仍 0.1.20。实际 Node 24.15.0 启动最终编译的身份 CLI，读取实际完整包身份并返回相同 artifactId、退出 0、stderr 空；不是 Electron ABI、原生宿主物理交还或 Agent 修复证明。本段和自修复文档新增只读核心说明在构建源捕获后追加，不属于该源码归档。

完整目标仍 active。下一步接通：外部更新关闭派发并确认物理退出后冻结基线→独立只读能力读取新普通业务推进→实际版本与 CLI 退出核验→管理库保存每条原需求的推进并在最终新鲜读取后关闭。无原任务时原运行操作恢复证据、已替代 revision 的重新验证/关联、非 Harness runtime 诊断及上述真实 Agent/整夜要求仍未完成。现有 3000/PID 54354 没有重启，未启动额外产品 Web/主 Loop，未提交/tag/推送；暂存区为空，现有用户修改保留。

## 基线采集接入原生外部更新（目标继续，2026-09-16）

上一目标轮新增只读核心及测试/类型/隔离构建，是 progress。本轮再次完整读取目标，接通外部 stopping 阶段：候选及 live-data 兼容检查→旧宿主/CLI 实际停止→稳定 Root 的 `runtime-business-baseline` 独立能力子进程→只读原业务库→独立管理库不可变 `repair_runtime_business_baselines`→candidate-starting。读取前后重查 Root、管理租约、更新 token/阶段/意图、原独立验证全覆盖、原安装、冻结源码及完整候选字节，另查被捕获旧进程组实际为空。缺失基线不能启动已验证修复的候选；读取失败沿受监督回滚，仍保留原失败和原数据，不能先运行候选再补拍。普通发行更新没有 RepairCase 时不伪造原任务；确实 ENOENT 保存 absent，不将损坏、权限、schema 或别名错误当成空库。

同时发现并修复更新静默周期会反复杀掉只读采集的时序冲突：Controller 增加 suspendCapabilities，原生管理分别拥有写/构建和基线能力调用；静默只排空写/构建，STOP、监督失效、shutdown 仍调用全量 stopCapabilities。没有放宽普通管理命令的 running/normal 权限；只有 Root 私有的停止阶段读取能力可以执行新入口。基线提交后重开/重试读旧记录，不重拍覆盖，不关闭 Case，不完成 Dev/Test。

新增 9 项测试，最终含相关只读核心的定向 70 项通过，独立 `tsc --noEmit` 退出 0，最终全量 1203 项通过（`/tmp/loopwork-runtime-baseline-admission-full.log`，63856ms，退出 0）。初次定向/类型检查分别暴露测试错误模块导入及重复导入，已更正并重跑，没有接受失败结果。实际原生验证 worker 运行固定候选响应及身份 CLI，完成两条原始 runtime 目标并实际退出后，另一个实际 Root-bound 能力进程才读取真实 SQLite 文件；fixture 的源码/五阶段编译 metadata 仍是受控设置，不宣称是真实编译修复或真实模型验收。反例包含真实旧宿主活着却被误标 exited，原生组检查拒绝；真正终止/close/ESRCH 后才准冻结；损坏 SQLite 拒绝且不改字节、不写空基线；管理重开/幂等读、禁止重拍、缺失基线禁止 launch。另一个实际 hung 能力进程证明 suspend 不杀只读子进程、STOP 确实结束其进程组，不能将这个 hang fixture 说成成功采集。原生协议测试没有新增真实模型或原业务完成捷径。

隔离 Next 和桌面构建分别退出 0（`/tmp/loopwork-runtime-baseline-admission-next.log`、`/tmp/loopwork-runtime-baseline-admission-desktop.log`）；根目录 `/tmp/loopwork-runtime-baseline-admission-build.qwwnRC`，源码 aaa6a7eacf44636d6ce65782f3fdec141b6fe5c7346f17900aaa84ffc89e60fa，产物 43d4a4aa3482ec358c4f40b6ffb78aa0a5c11fa85d6142a623b310ec62a401eb，版本仍 0.1.20。实际 Electron Node 24.18.1/ABI 148 运行 `/tmp/loopwork-runtime-baseline-packaged.uLOtcM/{verify.cjs,post-verify.cjs}`，均退出 0。将实际完整包及此前实际构建的 848c... 候选放入私有内容寻址缓存；实际 Root/管理/更新租约下调用最终编译的能力，在 publisher-only 更新静默中返回 null（没有 repair baseline 的发行更新），破损业务/应用数据库字节完全不变，零任务/Case/model/持有宿主/业务宿主。中性 stopped/aborted、Root/管理租约释放及 ledger 保留。独立 post 在父 PID 20554 结束后确认能力 PID/组 20568 消失、包及缓存实际身份仍匹配。这只证明打包 ABI 和独立能力入口，**不是有原任务的打包基线采集、实际业务进展、更新成功或自修复完成证明**。

完整目标仍 active。下一步仍需独立读取业务推进 candidate→关联真实已交还版本和 CLI 实际退出→管理库保存每条原需求证据→最终新鲜读取后关闭；无原任务的原操作恢复、变更 revision 的验证关联、非 Harness/构建前 runtime 诊断、真实 Admin 源码修复、三条真实 Agent 闭环及 8–12 小时整夜要求不因本轮缩减。Windows 有旧进程时本入口仍缺真实原生容器证明，不伪造通过。没有提交/tag/推送、主 Loop 或额外产品 Web，3000/PID 54354 保持原实例；本段在最终 source 捕获后追加，不在该已绑定源码归档内。

## 原生业务推进观察与关闭事务（目标继续，2026-09-16）

上一轮基线采集产生了实现与验证证据，属于 progress；用户随后的工作区状态询问仅做只读回答，没有提交或清理。重新完整读取 goal-objective.md 后接通下一段实际协议，不缩减原目标。

稳定 Root 受管能力新增只读 runtime-business-progress 操作，参数仅 Case ID，没有 Agent 提交虚构完成的接口。实际新宿主交还后才执行，不加载业务 bootstrap/迁移，不占普通 Agent 槽位。管理库重新授权当前完整独立验证、不可变原需求基线及完整候选、历史宿主身份/代次/业务监督 token 和 CLI 登记。Root PID 不能充当普通 CLI 所有者。原生子进程校验实际父 Root、当前普通宿主启动身份和进程组、全部候选字节与冻结源码，以及每个候选业务 CLI 进程组实际为空；较长文件校验后再核对一次普通宿主仍实际存活。只读一致查询要求正常 applied execution/result/agent complete event、当前 epoch、无暂停/介入/取消及 execution 进程退出。不能使用旧结果、ready 标志或直接完成 Dev/Test 代替推进。

新增管理库 append-only 业务进展历史和最终闭合清单。部分原需求推进先保存但不关闭；所有原需求的新证据必须已物理验证并持久化，最终新鲜一致读取精确匹配后才在管理事务关闭。正常新 CLI 登记不无谓丢弃已经退出执行的来源；真实版本/结果/宿主变更需要重读。重复关闭验证当前代次历史，不再次派发；复发保留同一 Case 的原始故障、独立验证和各轮进展，新故障使旧代次无权关闭。读取或物理证明失败保存标准 runtime 来源事实，每验证轮唯一 runtime-progress 恢复预算 ID 进入自动调查；STOP/失去监督不能增加失败事实。

新增 2 个聚合协议测试，最终定向 72 项通过（/tmp/loopwork-runtime-progress-close-targeted-final2.log，15923ms，退出 0），独立 tsc --noEmit 退出 0，最终全量 1205 项通过（/tmp/loopwork-runtime-progress-close-full-final2.log，65909ms，退出 0）。实际 Node Root-bound 能力读取真实 SQLite，独立 Native 验证先执行候选响应/两条原 runtime 目标并确认进程退出。实际候选夹具宿主自认证并在自身实际进程组下登记/启动独立 CLI，CLI 通过私有 IPC 确定性释放，而不是假定睡眠到期。反例：CLI 被误标 exited 但实际进程组仍存活时不能保存进展；两原需求仅一条推进不能关闭；暂停后不能用旧持久化证据关闭；旧 execution/Root owner/复发代次/STOP 均不通过。原故障、部分进展、管理重开与闭合历史保留，观察前后业务库字节不变。测试原任务及完成行、五阶段 compiler 收据、更新 phase 和业务 token 是明确的受控设置，**不宣称是真实模型、实际外部版本激活或真实业务修复成功**。初次运行误将测试 bridge 放入实际安装，完整哈希门禁正确拒绝；随后移到独立数据目录。第二次测试重开管理库后错误复用已经关闭的 store 引用，已改为独立重开读取并重跑，失败日志没有被当成通过。

最终隔离目录 /tmp/loopwork-runtime-progress-close-build.0dZlqB；Next 与 Desktop 构建退出 0（/tmp/loopwork-runtime-progress-close-next-final2.log、/tmp/loopwork-runtime-progress-close-desktop.log），实际 sourceId 835f97d18e07e33495fda1140988368281ede11841463ca455744d2812985685，artifactId a33af57dafd2a353d3169bc195decec0a2a09907f73e42ab3754968fda9eef9d，版本仍 0.1.20。实际 Electron 运行最终编译 workspace-version CLI，输出精确 artifactId、退出 0，父 PID 3306、独立 CLI PID 3307 实际 ESRCH，读取前后完整包身份相同。这仅是实际 Electron 编译身份 CLI 证据，**不是实际打包业务恢复/模型闭环**。构建期间为覆盖后续门禁及测试改动重新执行最终构建与全量测试；较早的 1204/1205 通过不代替最终 source 的验证。

完整目标仍 active。下一步包括无原任务的原操作恢复证明、原故障复发时间范围/新 revision 的恢复 cohort 与原验收关联、正常等待和真实停滞的持久化观测、非 Harness/构建前 runtime 诊断、真实 Admin 源码修复/外部切换/原业务推进、三条真实 Agent 闭环和 8–12 小时整夜验收。Windows 原生容器仍未实现实际证明，当前新观察能力拒绝缺失证据，不伪造通过。没有提交/tag/推送，也没有启动主 Loop、额外工作台或停止原 3000/PID 54354。此记录在最终 source 捕获后追加，不在该已绑定源码归档内。

## 复发时间范围与冻结前真实回退链（目标继续，2026-09-16）

上一目标轮接通原生进展关闭门禁并获得实际验证证据，属于 progress；本轮先完整重读目标并核对代码，不缩减阶段 1–7。发现 native baseline 仍用 Case 首次 created_at 截取创建时间，复发的新需求可能漏入恢复范围；还发现原生回退以 superseded_by_item_id 建新 revision，冻结时只看旧 ID 会卡在已经失效的旧工作项。

管理库现在从本轮完整独立验证所引用全部原始故障的可信持久化 created_at 取得最早/最晚范围，而不是 Case 首次创建时间。最早边界用于历史完成/取消判定，最晚边界用于需求创建范围；故障期间已经完成、取消或 superseded 的义务仍保留，不能用最后故障时间擦掉。范围保存后不可改写；旧不可变基线不重拍。新增 optional originalStartBoundaryMs 兼容已有私有基线，旧格式继续使用原单点边界，不能凭空补历史。

冻结前发生回退时，只沿当前只读一致快照里的真实 supersession 链到当前头：task/work_key/kind/story_index 必须保持、revision 严格增加、所有链接存在且无循环。不取最新 revision、不接 unrelated 工作项。保存 predecessor IDs/revisions、当前契约身份及整链旧 execution 集合；多个原节点汇聚同一头只保存一次，且即使当前头先被读取也必须保留最长原链与全部旧执行。旧 schema 缺少 lineage 列时不猜。普通完成查询还要匹配冻结的契约身份、revision/epoch；冻结之后的另一 revision 不自动授权，需要新独立验证/关联协议，仍未完成该后续流程。这一实现不改业务数据、不替代原验收、不直接完成 Dev/Test。

新增 3 项受控只读协议测试，最终定向 22 项通过（/tmp/loopwork-runtime-recovery-cohort-targeted-final2.log，15865ms，退出 0）、独立 tsc --noEmit 退出 0，最终全量 1208 项通过（/tmp/loopwork-runtime-recovery-cohort-full-final.log，65349ms，退出 0）。覆盖后来受影响需求、区间内完成仍保留、首次故障前完成仍历史、范围倒置拒绝、区间后新需求不混入、真实两级链保留旧 execution、链缺失/循环/跨 task/work_key/kind/story/revision 拒绝、当前头契约身份改变不接受原证据、读取顺序与重复头不丢原链。原生 Root-bound baseline fixture 同时校验真正持久化两条故障时间的范围、篡改最早边界拒绝、只读业务字节不变、Root 能力物理退出及旧宿主实际退出门禁。fixture 的 original timestamps、SQL 任务/完成行、compiler metadata 和 update phase 仍是受控设置，不宣称真实 Agent 或实际源代码修复闭环。初次 apply_patch 因现有上下文不匹配整体拒绝，检查当前文件后重新应用；没有部分失败被当成成功。较早全量 1207 项通过后增加最终去重反例，再完整重跑 1208，不替代最终验证。

隔离目录 /tmp/loopwork-runtime-recovery-cohort-build.00PMIv，Next 与 Desktop 均退出 0（/tmp/loopwork-runtime-recovery-cohort-next.log、/tmp/loopwork-runtime-recovery-cohort-desktop.log）。实际 sourceId 70f37fb4418277ef3e2e9de1e6e51b1bd6f4c7dac4d381ded32ec390b783dd07，artifactId 81421c18c561c80d09ebbc8cc76c56fef2e2255f81c72397677325598e877312，版本仍 0.1.20。实际 Electron 最终编译身份 CLI 精确输出 artifactId、退出 0；父 PID 56142/CLI 56143，CLI 实际 ESRCH，前后完整包身份一致。这仅证明实际编译身份入口，不是实际打包的业务恢复/模型闭环。没有提交/tag/推送、主 Loop 或额外产品 Web，原 3000/PID 54354 保持不变。

完整目标仍 active。下一步仍包括冻结后新 revision 的独立再验证/关联（不能只放宽 ID 门禁）、没有原任务的原操作恢复证明、正常等待与真正停滞的持久化观测、非 Harness/构建前 runtime 诊断和旧轮候选复用、真实 Admin 改源码/独立原故障验证/外部版本切换/原业务推进、三条真实 Agent 闭环与 8–12 小时整夜验收。Windows 原生容器证据仍待实现，不伪造通过。本段在最终 source 捕获后追加，不在该已绑定源码归档内。

## 冻结后来源变更的自动再调查（目标继续，2026-09-16）

上一轮修复复发范围和冻结前 lineage 并取得验证证据，属于 progress。本轮完整重读目标、核对当前源代码后补上冻结后再回退的失效入口，不缩减原故障、验收、实际版本或业务推进要求。

Root 原生只读进展能力从一致快照读取尚未恢复原需求的真实 current item。冻结后 item 缺失、superseded/cancelled、revision 变化/倒退、epoch 倒退、native origin 或冻结的 work_key/kind/story 改变，不授予新 revision 使用旧收据的权限。同一原工作项普通 retry epoch 增加仍有效；已实际证明一条正常推进的需求不因另一 obsolete 节点再失效。暂停、项目删除或明确整需求取消是用户控制，不产生修复失效事实。读取时依然校验当前 Root/管理/独立验证/候选字节/宿主与 CLI 物理退出，先保存已证明的部分推进，然后再新鲜读取来源变化。

管理事务要求每条变化属于冻结原需求且真正失效、无重复、当前只读变化精确匹配、实际基线/交还来源未变。保存 repair-runtime-cohort-changed、当前 artifact、原基线、部分进展、稳定恢复预算 ID，回到同一 RepairCase 新 Admin 调查。原始通过收据不改写，但旧门禁不能完成新步骤。requiredOriginalCoverage 与提示协议明确它是派生权限失效，而非新增原验收；全部原故障/验收仍需新一轮独立覆盖。Admin 可按该派生事实当前实际 image 恢复准确源码，再经完整修复/独立验证/更新/冻结/普通推进流程。不新建 Agent 完成命令、不直接改业务状态，也不将来源变化交给 LLM 错误分类器。当前仍走完整候选构建，跨轮候选复用优化未完成。

新增 4 项测试，最终定向 26 项通过（/tmp/loopwork-runtime-cohort-invalidation-targeted-final3.log，19917ms，退出 0），独立 tsc --noEmit 退出 0，最终全量 1212 项通过（/tmp/loopwork-runtime-cohort-invalidation-full.log，66120ms，退出 0）。纯只读测试覆盖 epoch 增加、实际 supersession/revision/缺失、完整原关系、暂停/删除/明确取消、写连接拒绝和 STOP。实际 Node Root-bound capability 变体证明：A 的实际独立 CLI 退出后部分推进保存，B 再回退到 b2，过期读取/无关节点/伪造未失效状态不能提交；实际能力将同一 Case 置 queued，原 2 条验收依然是 2 条、旧通过收据和部分推进保留、旧收据不能关闭。下一调查实际恢复当前 image 的源码 action 完成，恢复预算包含持久化失效 ID。独立 STOP 变体在已变更 B 的实际 SQLite 上拒绝记录/调用，零新失效事实且业务字节不变。任务/完成行、compiler 收据、update phase 和 token 是受控 fixture；**不是新独立验证已经通过、实际外部激活、真实模型修改源码或真实业务完整恢复**。初次测试使用了不存在的 action.receiptKey，独立类型检查和实际断言均拒绝；改为实际 key 后重跑，未接受失败结果。

隔离目录 /tmp/loopwork-runtime-cohort-invalidation-build.66dXUQ；Next 与 Desktop 均退出 0（/tmp/loopwork-runtime-cohort-invalidation-next.log、/tmp/loopwork-runtime-cohort-invalidation-desktop.log）。实际 sourceId 117c24e02b0296253e9844bc736a903cdb9374f0a346c4f9a108262cd2299261，artifactId aa8981e9b7b1b7f30c68edee6f655d2e3ba3f1e067b527d2a5967531109d0609，版本仍 0.1.20。实际 Electron 最终编译身份 CLI 精确输出该 artifactId、退出 0，父 PID 95264/CLI 95265，CLI 实际 ESRCH且完整包前后身份一致。仅证明实际编译身份 CLI，不替代实际打包修复效果。没有提交/tag/推送、主 Loop 或额外产品 Web，原 3000/PID 54354 保持不变。

完整目标仍 active。下一步仍需要持久化正常等待/真正停滞观测、无原任务的原操作恢复、非 Harness/构建前 runtime 诊断/已有候选跨轮复用、真实 Admin 源码修复/独立原故障验证/外部切换/原业务实际推进、三条真实 Agent 闭环与 8–12 小时整夜验收，以及 Windows 实际原生容器证明。核对发现 inspectDispatchInDb 仍间接使用 activeCommandChainYaml→appDatabaseConnection（可能初始化可写应用库）；不能在 Root 只读诊断里直接加载它来假装精确 eligibility，需先拆出可注入只读依赖。当前没有新增以 display ready 或无反馈计时冒充可派发停滞的捷径。本段在最终 source 捕获后追加，不在该已绑定源码归档内。

## 连续派发观察及迟到接管门禁（目标继续，2026-09-16）

上一目标轮补上冻结后来源变更入口并取得验证证据，属于 progress。之后用户工作区状态询问仅做实时只读核对。本轮完整重读目标阶段 1–7，继续修复真实停滞与正常等待的界限，不缩减总体修复闭环或验收目标。

发现既有业务交还观察在 120 秒以上无样本或时钟回拨后仍保留旧累计时间，后续一个样本可能拼成假连续 20 分钟；故障上报只查累计值，不查最后样本新鲜度。新增纯领域 repair-dispatch-watch，持续可派发时间只由相邻、同意图代次、有效时钟的 runnable 样本累计。长断档、回拨、暂停、执行中、资源/依赖/并发等待和来源变化重置连续区间；重复采样不增加时间。短间隔管理重启仍使用持久化观察。达到 20 分钟不是永久接管授权：assertHandoffStallCurrent 在业务 hold 的前后 assertCurrent 与管理故障事务入口重新校验新鲜度、独立验证、交还来源及监督。异步能力等待过久后不暂停业务、不新建故障，重新采样；不直接完成 Dev/Test。

新增 4 项测试：最终定向 28 项通过（/tmp/loopwork-dispatch-watch-fresh-targeted-final.log，984ms，退出 0），独立 tsc --noEmit 退出 0，最终全量 1216 项通过（/tmp/loopwork-dispatch-watch-fresh-full.log，67470ms，退出 0）。领域策略覆盖临界 120 秒、20 分钟、所有正常等待、同时间重复样本、意图变化、时钟回拨/非法输入。真实 SQLite 管理重开测试先累计 19 分钟再断档，恢复后一分钟不能把旧时间拼满；完整新的 20 分钟后才能授权，迟到故障记录与回拨拒绝。Controller 能力延迟反例证明累计满额后等待 120001ms，业务事务 assertCurrent 拒绝，零新停滞 intervention/管理 observation，Case 保持 observing。仍是受控时钟与 CLI/验证 fixture，不是三条真实模型修复或整夜验收。

隔离目录 /tmp/loopwork-dispatch-watch-fresh-build.SUGQAK；Next 与 Desktop 构建退出 0（/tmp/loopwork-dispatch-watch-fresh-next.log、/tmp/loopwork-dispatch-watch-fresh-desktop.log）。完整 readHarnessArtifact 实际校验全部包字节，sourceId 4618981aa9d87a204d7646fb03f77c6c10cd9def2ca9d4e69363566c725e961f，artifactId 71cec49041de643418c341685b7df6b46917d1813520c33c17e0350bf807b820，版本仍 0.1.20。不宣称实际发布切换或模型修复效果。没有提交/tag/推送、主 Loop 或额外产品 Web，原 3000/PID 54354 未改动。

完整目标仍 active。runtime 恢复集合的持久化 eligibility 观察仍未接入；核对进一步发现重型派发依赖经工作流模块存在顶层命令链加载，仅注入 workItemLine 的 resume profile 不足以保证 Root 不初始化业务/应用库，应拆出真实只读派发依赖边界。无原任务原操作恢复、非 Harness/构建前诊断及候选跨轮复用、真实 Admin 修复/独立验证/外部切换/原业务推进、三条真实 Agent 闭环、8–12 小时验收和 Windows 原生容器仍待完成。本记录在最终 source 捕获后追加，不属于该已绑定归档。

## 独立派发查询核心与纯协议目录（目标继续，2026-09-16）

上一目标轮修复连续派发观察及迟到接管门禁，产生代码和验证证据，属于 progress。本轮完整重读目标阶段 1–7，继续拆除 Root 诊断与业务初始化的隐性耦合，不将总体目标缩小为只读单元测试。

把既有普通派发队列选择、资源排序/预留、工作项来源绑定与 envelope 转换迁到 createDispatchQuery。运行时仅依赖纯领域资源/优先级值，持久化图、资源、容量、依赖、上下文会话、resume 支持及协调均显式注入。普通 dispatch-planner 成为原适配器，仍调用原协调和 stale-claim 清理，不改正常 admission。独立 inspection 禁止协调/清理；未提供协调端口却请求 admission 时明确拒绝。纯 agent-command-profile-catalog 保存原固定协议元数据，resume 判断不导入 YAML/config；原 agent-command-profile API 重导出保持现有消费者和提示协议，完整命令链渲染仍走原配置加载路径。

新增 2 项聚合测试。最终定向 36 项通过（/tmp/loopwork-dispatch-query-targeted-final5.log，1666ms，退出 0）、独立 tsc --noEmit 退出 0，最终全量 1218 项通过（/tmp/loopwork-dispatch-query-full.log，67250ms，退出 0）。实际 SQLite 上核对原普通适配器与注入核心、项目写入互斥/非锁 Agent 并行、优先级/容量、暂停、精确 item/revision/epoch 和 resume，inspection 不执行 refresh。esbuild 实际依赖清单证明核心仅三个纯模块、协议目录仅自身；独立 Node 编译子进程在真实 readonly/fileMustExist SQLite 执行非空派发选择，故意损坏的 business/config bootstrap 目标字节不变。部分 eligibility 端口在该独立反例中明确是夹具值，**不宣称完整 Root 生产只读适配器或真实 Agent 修复成功**。初次 apply_patch 同一路径 delete/add 被原子拒绝，改为 update；初次类型检查发现历史测试的 refresh 可能 undefined，改成显式拒绝缺失 adapter 的有类型方法；新夹具错误模块路径和非法 high 优先级先后被实际运行拒绝，检查真实 exports/1–9 规则后修复并最终重跑，未把失败当成功。

最终隔离目录 /tmp/loopwork-dispatch-query-build.L3ZDCs，Next 与 Desktop 构建退出 0（/tmp/loopwork-dispatch-query-next.log、/tmp/loopwork-dispatch-query-desktop.log）。完整 readHarnessArtifact 实际核对包字节，sourceId 96dfad65fd2f13e2d0a2d90fcf4158c53778e1cc92fd45530cf8ec0b2681e4a2，artifactId 74c25e2b2abfb2335776469761e0c4a560de3d8febddadc7d6d2f311174aed6c，仍 0.1.20。没有提交/tag/推送、主 Loop 或额外产品 Web，原 3000/PID 54354 保持不变。

完整目标仍 active。下一步提供完整实际只读 adapter 并接 runtime 持久化停滞观察；当前 core 隔离测试不能替代它。核对 execution-delegation 的固定 profile/hash 仍来自配置/数据库模块，work-item-artifacts、原文档依赖验收、work-items 的 ready 查询、并发与上下文读取仍需拆出共享只读边界，避免复制简化查询冒充真实 eligibility。无原任务原操作恢复、非 Harness/构建前诊断/已有候选复用、真实 Admin 修复/独立原故障验证/外部切换/原业务推进、三条真实 Agent 闭环、8–12 小时验收及 Windows 原生容器仍待完成。本段在最终 source 捕获后追加，不在该已绑定源码归档内。

## 生产实际只读派发适配器（目标继续，2026-09-16）

上一目标轮抽取共享派发核心并取得测试/构建/编译子进程证据，属于 progress。本轮完整重读目标阶段 1–7，继续完成独立 Root 读取边界，不缩减实际修复、验证、业务恢复和整夜验收要求。

原 hash 改由纯 content-hash 提供、database 重导出保持消费者兼容；execution-delegation 使用纯固定协议目录和同一 digest，work-item-artifacts 不再导入数据库初始化。实际 ready 查询、前置需求/正式文档来源判定、并发 schema/读取及上下文会话读取移到共享 query 模块，原业务模块重导出同一函数而非复制规则。dispatch-query-reader 注入这些实际函数及原资源/进程屏障，禁用 stale claim 清理/协调/投影，不加载 database、命令链配置或 Web。inspectDispatchReadonlyInDb 要求调用方 readonly 连接，一致事务前后执行监督检查；错误不变为空队列。原业务交还观察改用同一 inspectPersistedDispatchInDb，连接与写入事务仍归业务方，不向 Root 授予可写业务连接。

新增 4 项聚合测试，最终定向 43 项通过（/tmp/loopwork-dispatch-reader-targeted-final2.log，1035ms，退出 0）、独立 tsc --noEmit 退出 0，最终全量 1222 项通过（/tmp/loopwork-dispatch-reader-full.log，66163ms，退出 0）。实际 readonly SQLite 与原普通 inspection 精确比较：项目资源互斥、暂停 owner 的陈旧 claim 不删除、未退出 allocation 屏障不能被 cancelled/paused 绕过、全局并发、STOP 回调和无正式交付事实的 terminal display label。独立 esbuild/Node 子进程运行完整生产适配器，不使用简化 ports：真实图/claim/依赖/容量得出非空队列，故意损坏的 bootstrap business/config 及实际读取的 DB/WAL 字节不变，依赖清单无 database/config/投影/Web。正式规格产物通过原 execution/output/result publication API 发布后，readonly 连接验证冻结 publisher/实际 applied result/内容；合法状态放行依赖，污染内容/冻结 JSON/applied result 均阻止，waiting Closure 的人工阅读保留。图、人工完成 fixture 前置项、结果提交和 allocation 是受控数据，**不是实际模型修复、CLI 物理终止或外部切换的证明**。

编辑草稿提取 ready 函数时因范围不完整先拒绝；多次 grouped apply_patch 因重复路径或乱序 hunk/空行上下文被拒绝，检查当前文件、合并并按源码顺序后再应用。先前 hash 分离已成功，其他拒绝均没有当成已完成；实际源代码、类型和全部测试最终复核。没有用弱化 eligibility 规则消除错误，也没有新增 Agent 完成命令。

最终隔离目录 /tmp/loopwork-dispatch-reader-build.CABWfW；Next 与 Desktop 构建退出 0（/tmp/loopwork-dispatch-reader-next.log、/tmp/loopwork-dispatch-reader-desktop.log）。完整 readHarnessArtifact 实际校验包字节，sourceId 0a3fb64c7c8c97ab8264a1fcfb35411fb0c2ca89eaf9f4093d0244352c96a21c，artifactId face85c889812fc0cf3b8055e000cbd920ebb7943407c190e185e229311f2308，仍 0.1.20。没有提交/tag/推送、主 Loop 或额外产品 Web，原 3000/PID 54354 保持不变。

完整目标仍 active。下一步把实际只读入口接入 Root runtime 进展能力及管理库持久化正常等待/真实停滞观察，同时保留原独立验证/源码字节/物理宿主/CLI/代次来源门禁。当前完整 adapter 测试不能替代该受管能力。无原任务原操作恢复、非 Harness/构建前诊断/已有候选复用、真实 Admin 源码修复/独立原故障验证/外部切换/原业务实际推进、三条真实 Agent 闭环、8–12 小时验收及 Windows 原生容器仍待完成。本记录在最终 source 捕获后追加，不在该已绑定源码归档内。

## Root 原业务连续可派发停滞观察（目标继续，2026-09-16）

上一目标轮仅核对 Git 工作区，没有改变权威状态，属于 no progress。本轮重新完整读取 goal-objective.md 后，将上轮已拆出的生产实际只读派发适配器接入 Root 的 runtime-business-progress 能力，不缩减真实修复、独立验证、物理交还及原业务推进要求。

Root 依然先重验当前完整候选字节、冻结源码、当前宿主身份/进程组、交还代次和所有业务 CLI 物理退出；随后以 readonly/fileMustExist SQLite 连接调用与正常调度共用的生产查询，核对依赖、当前 Work Item revision/epoch、全局并发、业务与 Admin 资源 claim、未退出进程屏障、Intervention、暂停/取消和正在执行状态。结果是全部未恢复原需求的完整快照，不是 UI ready 标签或无日志推测。查询错误不会降级为空队列。

独立管理库新增 repair_runtime_dispatch_watches，按验证轮次和原 task 持久化来源绑定、监督意图代次、readiness、连续可派发时长及最后样本。只有相同已验证交还收据、相同精确 item/revision/epoch 且相邻新鲜样本始终 runnable 才累计；依赖/资源/并发等待、暂停、执行中长命令、已结束、监督代次变化、时钟回拨或超过 120 秒断档都清零。连续 20 分钟后还要在同一管理事务内重验快照、交还收据、意图代次和最后样本新鲜度，才保存 repair-runtime-dispatch-stalled 派生事实并重新排入同一 RepairCase。它不是新原验收，原故障、原验收、原独立通过收据和已保存的部分业务进展全部保留。它只会使恢复策略继续调查，不直接完成 Dev/Test、不修改业务库、不转人工。STOP 在取样和故障事务上都会失效旧授权。Admin prompt 同步明确该派生事实不可替代 originalObservationIds。

原生能力 fixture 升级为生产派发读取契约，将 dispatchTaskSelect 的完整 task 字段、Work Item 来源绑定和实际依赖/资源/进程/Intervention 表结构提供给受控 SQLite；不再因缺 title 等列而绕开生产适配器。新增 stall 与 stall-stop 两种变体：受控持久化时钟先证明 120001ms 断档清零，再证明连续达阈值才形成同 Case 派生调查；STOP 变体零新故障。两者均核对业务库字节不变、A 仍 ready/B 仍 waiting、completion_authority 仍为 null、原 2 条验收仍为 2 条。这是受控时钟和受控业务图的原生 Root 能力证据，**不宣称实际等待了 20 分钟、使用真实模型修复或完成外部版本切换**。

最终独立 tsc --noEmit 退出 0，定向 39 项通过（27297ms），全量 1224 项通过（/tmp/loopwork-runtime-dispatch-watch-full.log，66004ms，退出 0）。Next/Harness 与 Desktop runtime 构建退出 0（/tmp/loopwork-runtime-dispatch-watch-next.log、/tmp/loopwork-runtime-dispatch-watch-desktop.log）。完整 readHarnessArtifact 重读全部 2067 个安装文件通过，sourceId 508f7c080b515f1a83f93be4087bbdc4ec7551178393b1c296ee9a37430a3980，artifactId 8f8be2cbce4af77818cf8b3c75c94506ad848c26e53ce029e5d324b564d42b27，版本仍 0.1.20；打包 admin-business-worker.cjs 实际包含 readRuntimeBusinessDispatchInDb 及派生事实。初次误用 Vitest 运行 node:test 文件，Vitest 明确报 no test suite；该结果未被当成通过，立即改用仓库 tsx --test 入口并完整重跑。没有提交/tag/推送，没有启动主 Loop、额外产品 Web 或替换当前服务。

完整目标仍 active。下一步优先补齐无原 task 的原 runtime 操作恢复证明，以及当前 image 在构建前即无法启动时的外部诊断/已验证旧候选复用；之后仍须完成真实 Admin 修源码、全部原故障独立验证、外部切换和原业务实际推进，三条真实 Agent 闭环、8–12 小时实际整夜验收及 Windows 原生容器证据。本段在最终 source 捕获后追加，不在该已绑定源码归档内。

## 无原 Work Item 的实际 runtime 操作收据（目标继续，2026-09-16）

本轮继续核对完整目标后发现：切换前业务库不存在，或存在但故障时还没有形成 Work Item 时，不可只因 tasks=[] 关单，但旧 runtime-business-progress 也在 requiredCount=0 时直接 waiting，导致已修复并交还的 runtime Case 永久无法闭合。

新增 runtimeOriginalOperationReceipt。它不把空任务列表、宿主 ready 行或心跳当成修复证据；Root 在完整候选字节、原冻结基线、当前普通宿主实际父子身份/进程组、旧写入者退出、交还代次和全部原始独立验收再次通过后，用 readonly/fileMustExist 连接重新打开实际 loop-ui.db。只有 tasks/workflow_items/execution_attempts 及 loop_supervisor_lease/loop_lifecycle_state 实际协议表完整、lease 未过期且 fencing_token 精确等于私有 IPC 绑定的新普通宿主 businessSupervisionToken、生命周期处于 normal 且非 crashed/无 last_error，才产生收据。收据绑定同一 case/验证轮次/update/artifact/handoff 和排序后的全部 originalObservationIds。

管理库新增 append-only repair_runtime_original_operations。关闭事务再次读取完整原操作收据、重验当前交还/基线/候选字节/独立验收及管理授权，然后才保存收据并关闭 Case。有冻结 Work Item 时明确禁止用该路径，仍必须等原业务真实 applied result/complete event/CLI 物理退出。已保存收据不可改写，精确重放幂等。业务库不存在、协议缺表、外来/过期 lease、监督 token 不匹配、crashed 或 last_error 都使能力失败，由既有 runtime-progress 恢复事实继续同 Case 调查，不转人工。

新增 3 项测试：2 项纯只读协议反例覆盖写连接、缺表、过期/外来 lease、不健康生命周期和有原 Work Item 时禁止替代推进；1 项 Root-bound 原生能力从不存在的业务库冻结 absent 基线，通过独立候选验收、外部更新收据、实际候选宿主进程组/私有 CLI 认证/物理交还后，先用错误 token 证明不能关闭，再用与交还精确相同的 token 得到 progressCount=0/requiredCount=0 的 closed 收据。前后业务库字节不变，原两条验收仍绑定收据，没有创建任务或直接完成 Dev/Test。SQL 协议状态和候选 compiler/验收仍是受控 fixture；宿主及 Root 能力进程身份/退出是实际 POSIX 证据，**不宣称真实模型修复或生产数据库恢复**。

最终独立 tsc --noEmit 退出 0，定向 42 项通过（29847ms），全量 1227 项通过（/tmp/loopwork-runtime-original-operation-full.log，66203ms，退出 0）。Next/Harness 与 Desktop runtime 构建退出 0（/tmp/loopwork-runtime-original-operation-next.log、/tmp/loopwork-runtime-original-operation-desktop.log）；完整 readHarnessArtifact 全字节重读通过，sourceId 117eb721ab53c03224ff15ac661b18418769c357935ed3a3e717f9ad75d81282，artifactId f6f0b512d934340e14004519c903243534ac2aaf2631b3f1f757fe972b13a8e3，版本仍 0.1.20。打包 admin-business-worker.cjs 实际包含 readRuntimeOriginalOperationInDb 和 repair_runtime_original_operations。没有提交/tag/推送、没有启动主 Loop、额外产品 Web 或替换当前服务。

完整目标仍 active。下一步是完成当前 image 在构建前无法启动时的外部诊断、已验证旧候选跨轮复用，以及真实 Admin 源码修复/全部原故障独立验证/外部切换/原业务推进。三条真实 Agent 场景、8–12 小时实际整夜验收与 Windows 原生容器证据仍缺失，不标记完成。本段在最终 source 捕获后追加，不属于该已绑定源码归档。

## 独立管理镜像与同源码候选复用（目标继续，2026-09-16）

上一目标轮只读取 Git 状态，未改变权威状态，属于 no progress。本轮重新完整读取 goal-objective.md，继续处理“当前业务 image 在任何业务能力启动前已经损坏”的入口，并补上跨轮重复编译的安全复用；不把它们缩减为普通 Runner 内重试。

桌面包现在物理包含相互独立的 `app-server` 与 `management-bootstrap` 两份完整 runtime。Electron 主进程只从后者加载外部管理组合、原生依赖和恢复入口；业务镜像仍作为待验证安装传入。完整业务 artifact 校验失败时，Root 只从损坏镜像稳定读取源码归档、版本、 Next Build ID、声明 artifactId 和归档哈希，用独立管理镜像建立 `bootstrap-unavailable` 原始事实。只有完整内容寻址的管理 artifact 与损坏镜像的 sourceId/version 精确匹配时，观察才包含 `sourceArtifact/sourceEquivalence`，允许恢复该源码；不同来源管理镜像只能维持诊断，不能冒充故障源码或健康业务版本。独立 host service 也可显式配置同一绝对 `managementRoot`。打包钩子复制后分别重验两份完整字节，并要求 artifact/source/version 一致。

Harness build 在新轮编译前查询同 sourceId 的历史物理候选，但仅接受已完成的 investigation 尝试、原始 `harness-build` 动作、精确五阶段零退出收据、精确 toolchain、冻结源码动作及 `independentVerificationRequired=true/liveWorkspacePermission=false`。受控 fixture、有额外字段的伪记录、复用链和损坏字节都拒绝。复用时仍为当前 attempt 新建冻结源码工作区并记录单跳 `reusedFrom`；历史独立验证、外部切换和业务推进一律不复用。候选损坏或记录不合格会退回真实新构建，不伪造成功。

验证方面，Harness/source binding、native bootstrap、桌面双镜像、host service 及候选复用定向 35 项通过；包含实际独立 host restart、损坏数据库、管理 workers、独立验证与打包边界的扩展 72 项通过。最终独立 `tsc --noEmit` 退出 0，全量 1233 项通过（`/tmp/loopwork-bootstrap-reuse-full.log`，81379.9ms，退出 0）。跨轮复用测试的上一轮五阶段记录是受控 host-written metadata fixture；它证明严格筛选和重新验字节，不证明真实模型曾完成源代码修复。

隔离目录 `/tmp/loopwork-bootstrap-reuse-build.MenGMf`。首次 Next 构建使用指向工作区外的 `node_modules` symlink，被 Turbopack 文件系统边界正确拒绝；改为 APFS 物理 clone 后重新完整构建，Next/Harness 与 Desktop runtime 均退出 0（`/tmp/loopwork-bootstrap-reuse-next.log`、`/tmp/loopwork-bootstrap-reuse-desktop.log`）。最终 sourceId `198761195d7399db7f39bee02b604999ed6396736348cf4df8a7e7fee3225a99`，artifactId `ef5082c2db86b32eea6a8046392ae5faee123d56f37f92678ec5ff04259d70d2`，版本仍 0.1.20。

实际打包态进一步将该 Desktop runtime 通过最终 `installDesktopRuntimeImages` 安装到 `/tmp/loopwork-packaged-recovery.bmTyzg/resources/{app-server,management-bootstrap}`，完整校验得到相同 source/artifact/version。随后只移动临时 `app-server/desktop-runners/external-runtime.cjs` 模拟首镜像损坏：完整校验以 `Harness installed bytes changed; reject candidate` 拒绝，源码绑定仍精确；`management-bootstrap` 完整校验通过。实际 Electron 43.4.0 Node mode / ABI 148 从独立管理镜像加载最终编译的 `external-runtime.cjs`，在不调用 `start()`、不启动业务 Loop、Admin 或模型的条件下构造原生外部服务。它把管理 artifact 内容寻址复制到 data root，保存唯一 `bootstrap-unavailable` runtime 观察及完整 source equivalence，`attempts=[]`，随后 `shutdown()` 干净退出。这证明损坏首镜像之前的管理构造和诊断入口确实可执行；**不证明 Admin 已经真实改源码、独立原故障验收通过、版本切换或业务推进完成**。

完整目标仍 active。独立管理镜像只解决第一入口和精确源码恢复资格，不能替代实际修复闭环。仍需真实 Admin 对 LoopWork 源码进行修复、全部原故障独立验证、外部切换/失败回滚和原业务实际推进；还需三条真实 Agent 场景、8–12 小时整夜运行，以及由用户在 Windows 生产环境执行的原生容器验收。更广的非 Harness/构建前 runtime 故障也仍需用真实场景证明。没有提交/tag/推送，没有启动、停止或替换现有产品实例；临时打包目录仅用于隔离验收。本段在最终 source 捕获后追加，不属于该已绑定源码归档。

## 外部硬故障冷却与终止证据时序（目标继续，2026-09-16）

Admin 新增受宿主门禁的 `external-wait-requested` 提交结果。只有本轮已持久化调查发现、同一 RepairCase 最近完成的独立诊断、完整物理退出证明、两次匹配冻结基线的版本检查、全部原始 observation，以及至少一项真实非零复现或验收结果同时成立，才允许 Case 进入 `external-wait`。全通过的诊断不能被改标为外部故障。等待期限持久化为 `next_probe_at`；管理库重启后仍保持冷却，到期由原有公平 claim 自动重新准入，不转人工、不创建 Admin 的 Admin。

真实 UI 走查暴露终止命令的证据时序：命令在 CLI 内原子保存结构化结果并将 execution 从 `running` 切到 `output_received`，工具完成事件随后才到达 Harness。活动证据栅栏现允许同一 execution、run、task、Agent、pipeline、Work Item 和 dispatch generation 的这一唯一过渡；`verifying`、`applying`、`applied`、失败或取消仍拒绝迟到写入。回归测试覆盖合法终止过渡及所有后续状态拒绝。

修复前真实需求 `REQ-7c859849-ecad-4f05-ae11-fe7643cfb388` 的首轮 `phase complete` 被错误记录为 `evidence-persistence` 并重试。修复后使用原数据、原需求和原目标仓库恢复，新的同一 Work Item execution `862ed105-56b6-4741-ab5a-ef5576f87f7f` 保存 36 条活动检查点和 application 收据，正常进入 `applied`，随后派发交付拆分；没有弱化需求或直接改数据库。当前全量 1240 项通过、0 失败，独立 `tsc --noEmit` 与 `git diff --check` 通过。该需求的后续实现、独立测试和最终业务推进仍在真实运行中，不能据此宣称三条恢复闭环或整夜验收完成。

## 结构化结果提交后的物理终止（目标继续，2026-09-16）

继续观察真实执行时发现 Cursor Agent 已经通过 execution-scoped 命令持久化结构化结果，业务记录进入 `output_received`，但 CLI 仍可继续调用工具和读取内部数据。旧实现只在进程自然退出后读取结果通道，因此“结果已保存”与“执行已停止写入”之间存在实际窗口；数据库终态不能替代物理退出证据。

Agent invocation 现在持续观察私有结果通道。检测到合法提交后，优先等待同一个 terminal tool 的完成事件再立即请求整棵受管进程树终止；若执行器没有提供可识别的工具完成事件，则使用 1 秒有界宽限后终止。该终止拥有独立的 `submitted` 原因，不记为超时或用户取消；仍须等待原进程容器实际退出后才释放 allocation 和资源屏障。已经完成的工具 telemetry 继续持久化，逻辑执行结果使用已保存的结构化提交，后续自然语言或继续执行不能覆盖它。结果通道的临时无效读取会在有界轮询及退出后的最终读取中重试，不能把写入中间态当成有效提交。

新增真实子进程回归：fixture 原子提交结果、发出 terminal tool 完成事件后继续写入哨兵文件；宿主必须物理终止它，哨兵不能出现，同时保留工具完成 telemetry 和结构化结果。定向 delegation execution 24 项通过；独立 `tsc --noEmit`、`git diff --check` 通过；最终全量 1241 项通过、0 失败（82747ms）。本修复关闭阶段 1 的一个真实终止缺口，但不等于三条真实 Admin 修复闭环、Windows Job/guardian 或 8–12 小时整夜验收已经完成，完整目标继续 active。

## 可复跑的恢复故障注入入口（目标继续，2026-09-16）

此前真实验收依赖临时目录中的一次性 Cursor wrapper，注入规则、次数和状态文件没有产品仓库内的固定协议，不能作为阶段 7 的可复跑入口。新增 `scripts/recovery-fault-injection-agent.mjs` 和操作说明 `docs/recovery-fault-injection.md`。入口默认拒绝运行，必须显式提供仅用于恢复验收的确认口令、绝对隔离状态路径、execution id、模式和真实 CLI；不替换全局 CLI，也不进入 Desktop runtime entrypoints。

模型模式覆盖 Dev 漏实现、Test 使用旧服务、Test 误判三条目标场景；同一场景对 Dev/Test 分别计数，避免第二轮 Dev 已经超出注入上限而 Test 仍在首轮。Dev 漏实现的 Test 必须使用显式固定失败命令与摘要，从而保持可比较失败签名；旧服务/误判场景的 Dev 不用无关源码改动破坏停滞指纹。wrapper 同时支持 Cursor 文件引用参数以及 Codex/Claude/OMP stdin，保留原执行器参数和输出。合成模式覆盖正常退出不提交、持续输出不推进、持久化结果后崩溃。选择按 execution 幂等，次数有 1–100 的明确上限；并发状态写入使用独占锁和原子 rename，不能因 wrapper 重启改变同一次执行的故障。五项进程级回归验证角色独立次数边界、stdin 传递、无确认口令拒绝，以及私有结果 envelope 在受控崩溃前已经真实落盘；独立 TypeScript 与 diff 检查通过。

这只是阶段 7 的可重复注入能力，不是三条真实模型闭环已经通过。真实验收仍须在隔离实例中核对同一 RepairCase 的策略升级、实际修复、全部原目标独立验证、物理交还、业务推进、零 Agent 故障转人工与零残留进程；8–12 小时运行和 Windows 原生容器证据仍未完成。

## 只读验收审计与整夜证据检查点（目标继续，2026-09-16）

新增 read-only `recovery-acceptance-audit`，每次重新读取独立管理库和业务库，联合检查：指定 RepairCase 实际存在；关闭 Case 有完整 `repair-verification` 收据；业务 Case 有 handoff 和 business-progress，runtime Case 有真实业务关闭/原操作收据；Agent 故障没有进入 `awaiting_human`；没有重复活跃 Admin 或 execution 物理分配；停止后没有 Admin/Runner/CLI 持久化进程屏障。指定 Case 不存在会明确失败，不能把现有普通 Dev/Test 回退后 `ready_to_close`、空 RepairCase 集合或绿色 UI 当作 Admin 闭环。

`scripts/recovery-soak-monitor.ts` 强制时长在 8–12 小时、采样间隔 5–300 秒，并要求列出全部期望 Case。每次采样重新以 readonly/fileMustExist 打开数据库，原子改名写入检查点；长连接 SQLite 快照不能隐藏后来进展。瞬时违规会永久保留在 `violationOccurrences`，最后状态恢复干净也不能抹去。SIGINT/SIGTERM 保存 incomplete/interrupted，不把短运行伪装成整夜成功；最终采样额外执行全部指定 Case 的闭环门禁。纯审计与短时钟测试覆盖真关单、假关单/转人工/重复所有权/残留、缺失 Case、逐样本检查点及瞬时违规保留；类型与 diff 检查通过。

在已有隔离真实 Dev-missing 临时场景上运行审计，业务任务确实进入 `ready_to_close`，9 次 applied、4 次 cancelled，但独立管理库 `repair_cases=[]`；带预期 Case 的审计退出 2 并报告 `required-repair-case-missing`。该证据确认旧场景只是普通回退成功，不能计入三条 Admin 闭环。监控器和审计器只是阶段 7 的验收基础设施，真正 8–12 小时运行尚未开始，完整目标继续 active。
