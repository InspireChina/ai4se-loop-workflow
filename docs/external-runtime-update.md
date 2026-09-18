# 外部运行版本更新：事务与启动门禁

> 当前默认策略（2026-09-18）：桌面安装更新后，下一次启动直接采用并执行安装包内的新 runtime，不再先全量哈希并复制成缓存版本。启动时会终止旧的 publisher/runtime 更新事务并把它们保留为历史记录，不再执行旧 runtime 到新 runtime 的准备收据、交接等待、候选健康激活或自动回滚协议。Electron 单实例、root fencing token 和业务监督代次仍防止旧进程获得新的写权限；旧进程清理改为后台尽力执行，不阻塞 UI 和普通业务。下文保留的是严格更新事务的设计与历史验证记录，仅用于可选的隔离/高风险维护模式，不代表当前桌面默认启动路径。

本轮实现外部更新内核、持久化门禁和业务生命周期的租约激活入口。它不依赖被替换的 Runner，不复活旧 Maintenance Runner，也不把版本启动成功当作 RepairCase 修复成功。

## 事务与代次

`admin_runtime_updates` 保留原 Case、不可变的已知可用/候选产物目录、源码与产物内容身份、选择版本、阶段、失败原因和独立更新租约。部分唯一索引只允许一个未结束事务。更新请求重放不能变换产物，旧代次和迟到阶段推进由存储层拒绝。`admin_runtime_update_events` 保存阶段与失败历史，分页读取。

该租约不占用业务 Agent 或 Admin 执行槽位，也不与业务监督租约混用。控制器续租、停止和代次探测独立于耗时校验及启动操作。Controller 退出会取消捕获的候选进程代次，但取消本身不代表物理退出，不解除持久化门禁。

## 固定协议

```text
停止旧代次并确认退出
  → 候选持有式启动 → 租约激活 → 观察启动健康 → 更新事务完成
               失败 ↘ 回滚排空 → 重新检查实际数据兼容
                     → 已知可用版本持有式启动 → 激活 → 观察 → 回滚完成
```

在启动、激活和观察阶段重新验证产物与兼容性，不能复用上轮“校验过”的口头声明。旧进程退出未确认时停留原阶段，不能启动冲突进程。候选启动或健康检查失败进入回滚；已知版本失败仍走受门禁保护的恢复，不转人工或伪造成功。

用户意图变化会取消捕获的活动，排空确认后结束事务，不恢复更新前的 `running`。控制器只释放更新静默，不覆盖用户的停止意图。更新成功/回滚成功不会关闭原 RepairCase，也不直接完成 Dev/Test；仍需原始失败、原验收和后续正常业务推进验证。

## 两层启动屏障

发行更新另有独立管理库中的准备记录，保存 request/attempt、真实当前安装、目标版本、意图 revision 与 preparing/ready/transitioned/aborted 状态。桌面传入目标不再丢弃。只有所有实际清理检查成功且持久化未知进程屏障为空，才能从 preparing 标记 ready；同请求不可修改目标，旧恢复请求不能取消新准备。

新的原生 root 校验并绑定当前安装快照后，若 ready 记录的目标版本及实际 root-bound artifact 都匹配，才以原安装为 before、当前 bootstrap 为 candidate 创建现有 RuntimeUpdate。持久化安装仍保持 before，必须经过兼容性、实际排空、持有式启动、激活、健康检查和失败回滚；不是看到新版本就直接覆盖选择。旧或错误安装启动保持静默。用户停止改变 revision 时，废止旧准备而不恢复 running；普通显式恢复只能在实际退出检查通过且尚未进入 RuntimeUpdate 时取消准备。

这是发行更新的交接逻辑，不是 Admin 已完成源码修复、原始验收或业务推进的证据；不能据此关闭 RepairCase。真实安装目标版本、实际桌面安装器/GUI 与当前安装无准备记录的手动升级场景仍需单独验收。

未结束事务存在时，普通宿主重启和普通 `resume-after-update` 无权解除管理静默；业务侧自动恢复更新状态也暂缓。

`activateExternalRuntimeUpdate` 只接受当前独立更新租约，且阶段必须为相应的 activating。校验当前安装目录及实际 package 版本后，复用业务生命周期的更新恢复命令，只清除业务侧旧更新状态。管理静默仍拦截所有派发。外部健康验证达到结束阶段后，才由受代次约束的事务解除管理静默，让正常业务继续。

默认原生健康探测使用新鲜、分配/PID/产物绑定的私有 RPC，分别读取 `managementMode` 与 `businessMode`：激活前后的管理侧都必须为 update-silence，且当前更新仍有效；激活后业务本地模式必须 normal。初始业务模式可以 normal，因为派发由管理屏障明确禁止。两者不能混为一个 mode 字段，否则会错误拒绝合法持有式启动，也无法证明激活后管理屏障仍未提前解除。监督租约必须由实际候选持有且未过期，runId 为空、runPhase stopped、无错误。失败信息记录这些判定输入，不记录错误正文或提供商凭证。

外部 root 的只读宿主 audit 使用 `admin_runtime_root_artifacts` 绑定的稳定代码身份，不随业务安装选择改变。绑定前核对实际不可变产物，同一 root 代次不能替换；业务写入/发现/交还能力仍运行所选业务产物。旧业务产物不必实现新 audit 协议。这不等同于旧持有式宿主已经支持新的健康 RPC：已知版本的协议协商与真实失败回滚仍需单独验收。

此入口是外部宿主适配能力，不是普通 UI/Agent 的自由升级命令。原生适配器通过父进程私有 IPC 绑定分配 ID、实际 PID、产物身份与当前更新代次。宿主启动时校验实际父 PID、安装字节及监督所有权；激活收据必须证明当前所有权、业务静默与正常更新模式，不能把 observer/failed 收据当作已激活。

## 原生进程与安装字节

桌面构建生成 `harness-artifact.json`，逐文件绑定编译后的 runner、原生依赖、源码归档及 Next 构建身份。校验文件增加、删除、内容与可执行位变化；拒绝符号链接与硬链接。它是请求中已固定产物身份的一致性校验，不是代码签名或完整构建来源证明。

`admin_runtime_update_processes` 在 spawn 前保存不可变分配与真实父 PID，随后父、子登记实际 PID/启动标记。标记与进程组登记不能覆盖已保存的不同身份，阶段不能跳过 ready/activation 门禁。当前父进程可以重用自己的私有连接；连接丢失的历史分配必须先证明旧进程退出，不能因为记录缺 PID 就重复启动。

POSIX 清理确认实际进程组退出后才标记 exited。Windows 需要注入 Job/guardian 的容器退出证明，不能只依赖根进程 close。唯一例外是仍持有实际 spawn handle、收到启动错误且确证没有分配任何 PID，此时可以结束本次空分配；不能将此例外用于重启后来源不明的 reservation。数据目录不得位于不可变安装目录内。

日志管道持续排空并异步落盘；真实宿主通过私有 IPC 返回启动失败与激活拒绝。更新控制器继续拥有独立续租、停止和退出屏障，不占业务槽位。

## 数据库降级写入保护

应用与业务数据库在 journal/schema 写入前读取已应用迁移历史。发现当前读者不认识的迁移时，拒绝降级写入，保留实际业务数据，并由独立管理入口继续诊断。诊断给出完整未知迁移数量和有限预览，不静默忽略后续迁移。

历史库曾使用已停用的 `102_command_chain_variants.sql` 和 `102_agent_command_rejections.sql`。前者仅在草稿变体字段为可空 TEXT、无默认值且无活动 view/trigger 引用时认可；后者校验原有列集合、删除动作兼容的外键及无活动 view/trigger 引用。仅限业务库的这两项已知历史扩展，不是对任意旧编号的豁免。不删除历史记录或应用旧迁移 SQL。

这个保护单独不能证明同名迁移 SQL 变化的兼容性，也不等于完整回滚兼容方案。配套实现将迁移内容与安装源码绑定，在数据副本上独立验证新旧读者，并在候选实际写入后重新获取副本验证旧读者，见下节。不能为了代码回滚恢复旧数据库快照、丢掉新增业务写入。

## 隔离数据库读者与自动回滚兼容门禁

`createRuntimeDatabaseCompatibility` 使用 SQLite 在线 backup 复制应用/业务数据库，包含已提交 WAL 数据；只在私有副本上执行真正安装产物的 `database-reader.cjs`。读者启动前后都校验安装字节，显式覆盖工作区及 legacy 路径，不发现或导入真实外部仓库。管理库不参与业务迁移。

候选路径执行回滚目标初始化 → 候选初始化 → 回滚目标重新打开升级后的副本。回滚路径重新备份当前实际数据并检查回滚目标，不复用激活前的快照。完整投影保留所有原表/列、数据库对象、迁移历史及原始行（含重复行、大整数和 BLOB）；采用流式摘要而不是 LIMIT 预览。超过资源上限直接拒绝，不把截断结果当通过。

### 原安装字节损坏时的回滚来源

`request.before` 表示更新前实际持久化选择，不代表它当前仍健康。原生外部控制器先重新验证其字节；损坏时，仅从历史成功或成功回滚事务、匹配的真实持有式进程身份和激活记录中寻找另一个实际目录，并重新验证完整产物。不能把当前管理 bootstrap、刚构建的候选或只有 terminal 状态而没有持有式进程证据的记录当作健康来源。

回滚目标通过独立的 `admin_runtime_rollback_targets` 表固定，并保存来源更新 ID；原请求 JSON、原安装身份、原始失败和历史均不被改写。管理入口没有允许 Agent 任意声明回滚路径的命令。固定后每轮仍校验实际字节，失效时保留屏障继续诊断，不悄悄替换另一个目标。

候选升级和回滚均实际执行该目标的数据库读者，检查当前在线备份与候选迁移后的副本；兼容收据同时保存原安装、实际回滚产物和历史来源。回滚启动必须经过同一物理退出、持有式启动、激活和版本绑定健康门禁。没有可验证历史目标时保留更新静默，不恢复旧数据库或启动猜测的版本。历史启动与回滚健康只证明宿主恢复，不能代替原始业务目标的独立验证、业务推进或 RepairCase 关闭。

自动切换要求已执行的同名迁移 SQL 不变、原数据不改写、旧结构与旧约束保留；新增列必须允许旧写入。新增影响旧表写入的触发器/唯一索引、旧 CHECK 约束重写等被拒绝。只有原生旧读者能真实重新打开升级副本时才通过。未知迁移仍由旧读者拒绝：含破坏性、数据改写或旧读者不认识的 schema 升级必须安排单独的兼容桥接发布，不能为了自动修复取消门禁。投影不是任意 SQL/业务语义兼容的形式化证明；原失败与原验收的修复验证仍不可省略。

备份前后检查真实源文件身份和 `PRAGMA data_version`；校验期间新写入、新数据库出现或文件替换会使本轮副本失效。兼容收据保存在私有目录，包含版本、原/新投影、源数据版本与内容摘要。实现有完整行/字节/时长上限，未证明的巨大数据库不自动激活。

副本读者也在 spawn 前持久化分配，父子绑定实际 PID、父 PID、启动身份及进程组。当前调用只有实际退出确认后才把 pending 记录归档为 exited；重启遇到未知空 PID 保留屏障。超时/取消、下一轮检查、Native Controller 的 stop/cancel 都执行同一排空入口。Windows 仍需要原生容器退出证明，不把根 close 当全部退出。

## 持久化安装选择与不可变快照

管理库增加独立的安装选择与外部宿主租约。更新的成功、回滚、取消和安装选择更新在同一事务提交；旧选择不匹配时拒绝提交，不靠普通宿主启动覆盖新选择。重开历史管理库从未结束事务的已知版本或已结束事务的实际选择恢复，不丢掉更新门禁。

普通 standalone 启动在业务初始化前读取并核验持久化选择。如果旧入口对应的目录已经不是所选版本，实际 spawn 所选目录中的 `host-service.cjs`，而不是继续执行旧 bundle、仅改变环境路径。私有 IPC 和真实父进程关系继续传递。桌面初始化也在配置环境、创建 Lifecycle 和启动服务器前读取所选目录，并读取该目录 package 版本；桌面本轮只有代码顺序检查，未宣称真实 GUI 验收。

`stageRuntimeArtifact` 从已批准产物导入到数据目录下的 `runtime-artifacts/<artifactId>`，复制前、复制后及发布前核验原始与副本字节，通过目录原子 rename 发布。已有目录仅核验复用；损坏目录不覆盖，取消或监督权变化不产出可用安装。临时构建目录不是安装选择。普通发行安装器的可变 bootstrap 目录不会被首次普通启动自动钉为修复选择，以免破坏原有下载升级。

不可变目录与数据目录的隔离按实际目录位置核验，包括尚未创建路径的现存祖先，避免 `/tmp` 别名或目录链接绕过边界。快照的字节身份不是 OS 写保护，后续启动仍需再次校验。

独立 `createExternalRuntimeHost` 核心持有自己的续租权，合并并发 tick，更新期间先排空普通宿主，拒绝同时启动普通代次。长校验期间安装选择变化会取消旧启动。关闭同时尝试更新与普通进程清理，任何未确认退出都不释放外部宿主租约。Native 更新取消也必须汇总数据库读者与所有捕获宿主的退出结果；一个同步清理异常不能阻止其他进程清理。即使更新事务已结束，控制器 shutdown 仍须清理尚未转交的实际激活宿主。

## 原生普通宿主与组合入口

`admin_runtime_host_processes` 在 spawn 前保存不可变分配及实际父 PID，父子共同登记真实 PID/启动身份。只有当前外部租约、所选实际产物、无活动更新、私有就绪收据和完整进程身份均满足时，才转为 ready。未知空 PID 不因租约接管而清除；迟到登记不能覆盖不同 PID/marker，只有当前实际 spawn error 的正向空分配证明可以收尾。

普通宿主的新 `--host-allocation` 协议绑定管理库、真实父进程和私有 IPC，在业务导入前核验实际安装字节；启动后独立检查外部代次、父连接及安装/更新门禁。就绪需要真实 Lifecycle 监督所有权，而不只是打印 initialized。该协议须由已知可用 baseline 支持；不支持的新参数不会被悄悄当成功。

`createNativeRuntimeHost` 提供普通启动、私有连接重用、排空及捕获代次取消。POSIX 进程组退出和独立 CLI 后代退出必须同时证明；后代清理失败不阻止尝试终止根进程，却不能使记录转 exited。Windows 需要原生 containment 证明，没有根 close 放行默认值。任何未完成更新进程或读者都会阻止普通启动。

打包的 `external-runtime.cjs` 导出 `createNativeExternalRuntime`，连接独立外部核心、普通宿主、更新控制器和真实隔离数据库兼容检查。bootstrap 必须指向独立内容寻址快照。运行前排空历史更新分配时捕获记录，在清理前后复核当前 root/选择；关闭只取消已捕获的代次，不重新扫描并杀掉新所有者。宿主/更新容器与数据库读者容器有不同证明接口，显式接线，不能互换。

组合入口已将受认证普通宿主的 CLI 分配/排空接入独立管理库（见“普通宿主 CLI 独立台账”）；完整后代 containment、未登记旧宿主退出及独立更新健康证明仍为强制能力，没有 always-success 默认值。它尚不是可自动注册的 OS 外部根服务，也未连接 cached Admin 对 runtime 源码的修复、构建和部署命令。需要继续实现这些生产能力，而不能只把端口保留作为最终交付。

## 尚未交付

原生更新/普通宿主适配器、安装字节校验、持久化选择、普通启动选择接线、不可变快照及隔离数据库读者已有实现和受控验证；独立外部核心的原生组合及普通宿主 CLI 独立台账已连接，但 OS 外部根入口、未登记旧宿主/逃逸 CLI/未知启动窗的完整容器排空能力、Admin 源码修复到部署命令仍未连接。Native 适配器的完整退出和独立健康证明仍有强制注入端口；数据兼容已有真实实现，没有提供伪造成功的默认值。因此本轮不是“生产自动修复升级已完成”的验收。

还须完成上述接线、schema 不兼容升级的兼容桥接策略、真实修复构建到部署、修复选择后采用后续发行安装器版本的协议、外层 GUI/bootstrap 自修复、Next 可变缓存外置、恢复原任务验证、Windows 原生进程容器、三条真实模型闭环和 8–12 小时整夜验收。所选宿主根 close 不能证明主动逃逸/独立 CLI 组全部退出，不能省略原生 ownership/containment。

## 当前验证证据

### 普通宿主 CLI 独立台账

普通外部宿主在核验实际安装字节和实际 PID/启动身份后，先在管理库认证 CLI 登记协议，再初始化业务 Lifecycle。业务调用核验自身与实际宿主属于同一 POSIX 组，绑定已认证 ready 宿主、当前 root 代次、运行意图和安装选择，在 spawn 前保存 CLI 分配。PID/组同步登记，真实 marker 到达才转 running；覆盖业务 execution 及无 execution ID 的宿主 helper。业务库无法登记退出时，独立台账仍保留已确认的物理退出事实，业务库恢复后须自行处理原资源屏障。

Native 排空先持久化关闭该宿主的 CLI 分配入口，禁止重开或迟到初始化；然后同时清理根、独立 CLI 组并取得原生完整后代证明。独立组清理不导入或迁移业务库，未知 PID/marker 不能放行；一个组失败仍尝试其他组。入口写入失败不能阻止根被物理终止，但该轮不释放 ownership。对宿主调用即使注入“返回 true”的业务进程适配器，POSIX 物理结束仍由真实组退出确认决定。

空台账只有实际宿主认证过登记协议才支持“无已登记 CLI”的判断；旧宿主不能凭空台账证明没有独立 CLI。注册组证明仍不能替代逃逸后代/未知启动窗的 guardian 或 Windows Job 容器，完整 containment 端口保留，不能因台账成功而跳过。该生产路径仅启用在外部普通宿主下，未在当前主工作区 Loop 或 Windows 生产部署。

本轮 36 项定向及隔离全量 **1054 项通过、0 失败**，独立类型检查、Next 与 Desktop runtime 构建全部实际退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/cli-registry-validated-{targeted,tsc,full,build,desktop}.log`。受控真实进程检查包括根已退出但同组子进程仍写文件、业务库不可读时独立排空、业务 helper 无 execution ID 仍登记、伪成功自定义适配器不能绕过真实退出、关闭入口写失败仍实际终止根并保留屏障。

新真正打包 Electron 宿主 PID 77722、父 PID 77708 的证据 `/tmp/loopwork-independent-cli-proof.zm52os/evidence.json`，绑定构建源码 `f0f9e37947dba8f95a34d8b39ce9e3b6a311b4452eb87db68705a1470c8f864c`、产物 `c8907e60f47a44594aa487398182e22853744a327d40567f88cbe4adb48e88c1`（补本文档前快照）。独立只读 `post-verify.log` 核验实际 CLI 协议 certified=1、draining=1，root 租约 owner=NULL/expires_at=0、单条 exited 宿主、父子 PID 均不存在及所选安装字节不变。该打包实验用户 stopped、没有业务 CLI/模型修复；真实写入子进程证据来自上述定向检查，不能合并成生产模型或 Windows 容器验收。

### 冷启动故障复盘与关闭路径加固

隔离完整源码 worktree `/tmp/loopwork-real-repair.fWroPo/harness` 的首轮全量验收保留了 1035/1036 通过、真实 launchd 重启检查失败的日志 `harness-tests.log`。当时测试清理断言覆盖了主失败，旧 setup 又删除失败现场，不能从丢失的管理记录断言唯一根因。独立观察到受控假 CLI PID 70327 残留，按实际 OS 启动身份终止并确认 PID 不存在；未处理其他生产 CLI。

现在 Admin 分配只登记 PID 时保持 launching，实际启动身份落盘后才转 running；PID/进程组补登记不能虚报身份就绪或覆盖旧 marker。未知 launching 的物理退出屏障仍保留，**这不等于已解决宿主在未知 PID/marker 窗口崩溃的原生 guardian 问题**。同一真实 launchd 检查未提高时限，修正后 28 项定向检查通过，日志 `start-identity-targeted.log`。测试退出非零保留完整私有目录；清理汇总主错误与所有退出错误，不因一个错误跳过其他进程。`failed-file-retention-proof.log` 及对应私有目录中的实际文件另证退出 1 后现场保留。

隔离编译器显式绑定 frozen source、私有数据/工作区，剥离大小写变体 LOOP_*、NODE_OPTIONS/NODE_PATH 和测试环境，不继承活跃管理命令凭证。`harness-validated-build.log` 成功绑定源码 `c0b4c001a73e16d45743e97bb8ba4269f4ffcf799eb143549bb2bf9444221c79`；故意传入的三个保护数据库与工作区 sentinel 字节保持不变、无数据库 sidecar。此为可信编译器路径隔离，不是恶意依赖安全沙箱。

外部 root 的关闭现在合并同轮调用，但首次未确认退出的失败不会永久缓存；下一轮仍可清理捕获代次，绝不重新开放业务派发。更新与普通宿主清理均隔离同步抛错，只有全部退出证明成功才释放 root。更新 Controller 即使清理失败也等待已取消的在途操作收尾；次级清理异常写入诊断，不能覆盖原始启动错误。关闭增补后的隔离全量 1043 项、独立类型检查及构建通过，日志 `shutdown-{tests,tsc,build}.log`；其构建源码为 `ec4e5e4855ded41d0b6481d76983717c0720d6277ed61a2b39c73116144034b5`。后续 NULL 历史门禁修改必须使用新一轮验证，不能沿用该构建。

数据库读者拒绝 NULL/非文本已执行迁移，避免 SQLite NOT IN 的三值逻辑漏检；16 条错误预览每条最多 256 字符。`migration-history-targeted.log` 的 8 项检查包括生产编译 application/business 读者分别拒绝未来与 NULL 历史，原数据库字节及 delete journal 模式未变。没有改写历史数据库或放宽回滚门禁。

本轮最终完整功能源码的隔离全量 **1046 项通过、0 失败**，独立 `tsc --noEmit`、Next 构建和 Desktop runtime 打包全部实际退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/recovery-final-{tests,tsc,build,desktop}.log`；构建源码 `45c2beb6f9f6f9dba9547d71c7a0121a7ba8ec1afc852c9850fc542d2ad14a46`、产物 `cc1385f016752a17cd0ed08bd483b7a119b0d71f95fba9df6b6c9502480220ae`，对应补本文档前的隔离快照。

`/tmp/loopwork-shutdown-retry-proof.dw6aU4/evidence.json` 使用该真正打包 Electron 组合入口启动实际 ordinary host PID 46024：受控独立后代证明首次拒绝，根进程实际退出但记录和 root 租约不释放；第二次关闭重新核验后收尾，未再派发或 spawn。独立 `post-verify.log` 以只读管理连接核对 `admin_runtime_host_lease.owner_id=NULL/expires_at=0`、单条 exited 记录；父 PID 46011 与宿主均不存在，再次校验所选安装字节完全匹配。该实验没有业务 CLI，后代端口读取真实私有记录为空并故意拒绝一次；不是生产有活动 CLI 的 containment 证明，不是模型修复、GUI/OS 部署或原业务完成。

真实模型验收只完成准备：独立 detached worktree、私有样例仓库及 `acceptance-plan.md`，尚未在 UI 配置/创建需求/调用模型。临时切换唯一 3000 Web 的许可待用户确认，主工作区 Loop 未启动。三条真实修复闭环、8–12 小时整夜，以及上节全部未交付生产能力仍未证明；以上单元、OS 假 CLI 与构建证据不能替代它们。

- 原生普通宿主本轮 17 项定向、全量 1036 项通过，独立 `tsc --noEmit` 及隔离 Next/Desktop runtime 构建退出 0；日志 `/tmp/loopwork-native-normal-host-{targeted,full-tests,tsc,next-build,desktop-build}.log`。接线中的宿主/读者 containment 类型不匹配已由独立类型检查发现并修正，最终构建重跑通过。受控检查覆盖持久化空 PID 屏障、实际父 PID/进程组/私有就绪、重复 tick 不重复 spawn、后代证明拒绝和同步异常仍终止实际根、已有更新阻止启动及实际未创建进程的正向证明。
- `/tmp/loopwork-native-root-proof.609AnG/evidence.json` 使用真实打包 `external-runtime.cjs` 及 Electron 原生 ABI，启动真实打包 ordinary `host-service.cjs`、复用一次连接、shutdown 确认实际 PID `62215` 退出，再独立读管理库确认 record exited / root owner null / 用户 stopped。零业务运行、零管理执行；独立后代证明读取私有库的真实 execution/CLI 记录为空，不是对生产有活动 CLI 场景的证明。`post-verify.log` 再次校验所选快照字节未变化。源码 `e96c9acb1e158c25c0d20d5f33c1eb83b8aaeeb6652d6ebb17b4b8f8a34b13f7`，产物 `b79a3139185bb68a3b88d828ab0af2d7d528bc41aea674bfbe530fd491065034`，绑定补本文档前的隔离构建快照。没有进行更新、OS 注册、GUI、真实模型修复或原 Case 业务推进，本证据不能替代它们。

### 外部 root 启动故障记录及 ENOENT 修正

- 普通原生启动失败通过独立管理观察入口落盘；入口在同一管理事务检查 root 代次、意图 revision、selected revision 和无活动更新。停止 / fencing / 更新不是新的修复故障。未验证的 attempted source 不能冒充实际执行版本。损坏业务库的 cached Admin 消费路径已有受控子进程测试，但生产稳定 root-level Admin 服务尚未完成。
- 第一次真实打包 ENOENT 实验在 `/tmp/loopwork-root-failure-proof.1Xp13q/verify.log` 失败，明确留下“期望 ENOENT，实际未分配 PID”现场；该产物源码 `1a419cad607485dd04730f2aeb53a6ed7481d8efcf398cf7d073f62f9f07b0d4`、产物 `70aa9a808b5d8cbd8543278b94edb0b0f58648b90645238b9a9ee6e838b078f4`。没有覆盖这次失败记录。
- 修正后 25 项定向、全量 1063 项通过、0 失败，standalone tsc、Next、Desktop runtime 均退出 0。日志 `/tmp/loopwork-real-repair.fWroPo/root-failure-enoent-{targeted,full,tsc,build,desktop}.log`。
- 最新实际打包证据 `/tmp/loopwork-root-failure-enoent-proof.dCkopO/evidence.json`：父 PID 9003；实际 native root 使用不存在的绝对 executable，保存 ENOENT / 已校验来源 / 已退出且 PID null 的分配；另一独立私有快照修改 host-service 字节，实际校验拒绝且没有任何子分配，来源 unverified-attempt。两份故意损坏的业务库原始字节均保持不变。两 Case 仍 queued，绝不因诊断写入或退出成功而关闭。
- `post-verify.log` 是父进程退出后的独立只读核对：父 PID 不存在、两个 root owner 均 NULL、expires_at=0、没有活跃 host/CLI 分配、Case 未关闭、正常安装/快照字节仍有效，故意损坏的私有快照仍被拒绝。脚本 `/tmp/loopwork-root-failure-proof.1Xp13q/{verify,post-verify}.cjs` 使用新的证据目录参数；两个运行退出 0。
- 本次标识绑定补本文档前的完整隔离构建：源码 `b04d0ad6d0a0f6e7f7d422cf011fe8d4d2e8ed0b5ca940edd6adc316cfdc8aec`，产物 `fd975ff1c891fa9f23c650ceb5f68a8e1292d63f5535f35cdae67e32a6d200dc`。无子进程的确认端口仅适用于本次 ENOENT/校验拒绝 fixture，不是生产未知启动窗/逃逸后代/Windows Job 的完整证明；无真实模型、原业务任务、实际修复、更新或 OS 注册，不替代三闭环或整夜验收。

### 此前安装选择轮次

- 本轮 24 项退出/控制器定向检查、全量 1031 项通过，独立 `tsc --noEmit`、隔离 Next 构建与 Desktop runtime 构建退出 0。日志 `/tmp/loopwork-runtime-cancel-{targeted,full-tests,tsc,next-build,desktop-build}.log`。此前安装选择/暂存 12 项通过，全量 1029 项通过，日志 `/tmp/loopwork-external-root-selection-final.log` 与 `/tmp/loopwork-staged-runtime-full-tests.log`。新增检查覆盖未知 PID 屏障、同步读者清理异常不阻止真实宿主终止、结束事务关闭仍清理实际激活宿主。
- `/tmp/loopwork-runtime-exit-proof.uGfWZ3/evidence.json` 为真正打包 Electron 证据：执行打包的 staging 导出，发布已核验独立快照，激活候选，直接 controller shutdown 后确认实际宿主退出，再从旧 bootstrap 两次启动实际所选目录代码。独立复查 PID `27010/27208/27217/27218/27223` 全不存在，pending-readers 为空，所选目录未发生字节变化，正常 stderr 为空，用户意图 stopped、原 Case queued、零业务运行。源码 `aa3f1e26771f27374afd75484de209faa9303adfb0eb90515782f3409d079388`，产物 `627bb89ee2537fd4c3713a3f46ced69554adf157f202772e1854d424623d0a3f`；对应隔离构建快照，随后仅补本文档。受控差异是旧产物中的 marker，不是真实模型修复；没有旧普通宿主的私有场景使用确认端口，不能当生产排空/containment 的证明。这也不证明真实 GUI、OS 外部入口或原业务修复完成。

### 旧协议健康回滚验收（2026-09-16）

旧宿主未宣告健康协议时，现在通过稳定 root 的受管只读诊断能力检查实际更新分配、PID/启动身份、不可变产物、业务监督租约及更新静默，不发送其不支持的 `probe-update-host`。只有显式 `private-health-v1` 使用新 RPC；未知未来协议不能降级。读者取消失败不阻止物理终止，但保留未确认退出屏障。

真实旧产物回滚证据 `/tmp/loopwork-real-legacy-rollback-proof.I14nJK/{evidence.json,verify.log,post-verify.log}`：实际坏候选启动退出 1，自动恢复原已知版本，经默认旧协议校验后激活，再物理交还普通旧宿主。独立只读复查确认捕获宿主/能力 PID 与组、10 个真实 DB 读者均退出，租约为空，两个不可变产物字节身份完整，安装选择为旧版，原 Case queued、用户 stopped/normal、零模型调用。故障只在私有编译副本注入，不是 Admin 自主源码修复；普通 readiness 不是原业务推进。详细快照标识和日志见 admin-recovery-implementation 的同日旧协议章节。

### 此前数据库读者轮次

- 最新 13 项定向、全量 1015 项测试通过，独立类型检查及隔离 Next/Desktop 构建退出 0；日志 `/tmp/loopwork-db-compat-{targeted,full-tests,tsc,next-build,desktop-build}.log`。实际读者测试覆盖 WAL、完整数据保护、同名已执行 SQL 变更、旧版本不支持未来迁移、约束变化、源数据库校验期间新写入、真实读者超时与未知启动屏障。
- `/tmp/loopwork-installed-db-roundtrip.GYRdg2/evidence.json` 记录真正打包 Electron 的 6 次兼容收据、10 个实际退出的独立数据库读者，以及真实宿主私有激活/回滚。源码 `f8bb51cbde0bcf2aa773077dbd85314f4cdf4666f962b8591497e87c9d8f5b95`，产物 `376727dac32943849ddfaf547c9c4af13f6c1d905e71518122302eb36c03de1f`。本次数据兼容端口不是 stub；旧宿主来源为私有无旧进程场景，故障是副本中的受控启动异常。保留用户停止、零业务运行和未关闭的原 Case；所有实验宿主/读者均实际退出。这不是真实模型修复、生产 OS 根目录切换或原任务完成的证据。

### 此前轮次

- 43 项定向、全量 1006 项测试通过，独立 `tsc --noEmit` 与 diff 检查通过；隔离 Next 构建和桌面打包均退出 0。日志分别为 `/tmp/loopwork-native-update-targeted-final.log`、`/tmp/loopwork-native-update-full-tests.log`、`/tmp/loopwork-native-update-current-tsc.log`、`/tmp/loopwork-native-update-next-build.log`、`/tmp/loopwork-native-update-desktop-build.log`。
- 真正打包的 Electron `host-service.cjs` 在私有数据目录执行：注入候选启动异常 → 确认其进程组退出 → 已知可用版本取得实际监督权 → 私有通道激活 → 回滚事务结束 → 实际退出。用户停止意图、原 Case 与零业务运行被独立读取确认；正常宿主 stderr 为空。
- 证据 `/tmp/loopwork-native-installed-update.s3zKlH/evidence.json` 绑定源码 `07c2587d4b0727041f6d7fd020a7444ec38545dfbfe1985986c2e0518c4c9072`、产物 `8ea11ece05b71eea303f24114e9a4843cae5b73db3e13e6066579b2e650d1b3c`。候选异常是在产物副本注入的受控故障；数据兼容端口使用 stub。这不是真实模型代码修复、新旧数据库语义兼容或原任务恢复的证明。
