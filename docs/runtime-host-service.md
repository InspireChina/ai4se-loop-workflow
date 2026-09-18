# OS 宿主托管

## 当前安装损坏与缓存管理启动

原生管理构造先打开独立管理库，再校验当前 app-root。安装字节不可用时，只允许此前 Root 已绑定的私有内容寻址快照，逐个重验实际字节、完整身份和路径；不信任文件名、历史就绪摘要或任意目录扫描。最近八个不同绑定快照参与恢复，坏 JSON、损坏候选和抛错日志回调不能遮蔽下一候选。安装失败保留为 queued RepairCase，状态的 bootstrapWarning/BOOTSTRAP_UNAVAILABLE 不表示原安装已修复。无可验证快照时仍保存独立故障，但构造拒绝继续。显式取消不制造该故障。

本机实际 Electron 打包复验：`/tmp/loopwork-bootstrap-cache-proof.wMxyv9/{evidence.json,verify.log,post-verify.log}`。损坏私有 host-service 安装字节、保留原 manifest 后，缓存管理的真实停止/更新静默/取消恢复有效，父进程退出后所有捕获宿主/能力 PID 和组退出，独立租约清空；无缓存故障持久化且无子进程启动。未启动额外 Web 或模型，未声称业务修复成功。

注意：desktop 当前从安装目录 require external-runtime，standalone 也必须先加载自身入口。因此本轮不覆盖 native 管理 bundle 本身无法加载、外层 OS 入口损坏或升级 Electron 后缓存 SQLite ABI 不匹配。缓存选择发生在成功加载管理代码之后，不能据此声明所有安装损坏均可自动恢复。真实 GUI、真实 Admin 修复/独立原验收/业务推进及整夜验收仍待完成。

OS 负责重新启动稳定外部 root。独立入口使用 `createNativeExternalService`：root 持有独立管理库、Admin Controller 和续租，正常业务生命周期运行于独立的受管子进程；业务库加载失败不结束 root 的管理生命周期。
重启宿主不是启动 Loop 的命令；独立管理库中已保存的 stop 和 update-silence 仍然有效。
本配置生成器只写配置产物，不注册、覆盖或移除任何 OS 作业。启用托管是单独的运维操作。

## 桌面启动分级

桌面首屏、管理准入和 Admin 业务调度是不同阶段。Electron 可先显示本地控制页；外部 root 必须取得监督租约并排空旧写能力，才允许普通业务宿主准入。但配置发现、RepairCase 调度、Action 和 Follow-up 不属于普通宿主的同步启动前置；它们在本次普通/更新宿主准入尝试结束后由 Admin 后台继续。监督续租不依赖后台调度，因此慢发现不会让已取得的写隔离过期。

进程身份观测使用三态语义：明确 PID 死亡或读到不同启动标记立即失效；读到相同标记继续；OS 查询临时失败为 unknown，需连续多次无法确认才关闭子宿主。这不降低业务写入、Job 容器、版本选择或实际退出屏障；只是不再把单次观测工具崩溃当成身份已改变的正面证据。

## 两种入口

- `desktop`：直接启动已安装应用的真实可执行文件并传 `--hidden`。桌面源码已改为与 standalone 共用 `createNativeExternalService`，独立 root 先初始化管理库再读取、校验业务安装；界面通过受控私有 IPC 请求运行控制，不取得业务监督权。实际桌面 GUI 与发行更新后的选版、恢复仍待验收，不能仅凭源码接线声明迁移完成。不要把 `.app` 目录、快捷方式或启动脚本当作可执行文件。`data-root` 应为该应用实际 userData 下的 data 目录，不是另选一个目录；桌面配置仍由 Electron 初始化。
- `standalone`：默认运行打包的 `desktop-runners/external-host.cjs`（源码为 `scripts/loop/external-host-entry.ts`）。不启动 Web、不监听 HTTP、不直接修改工作项状态。显式 app-root 必须为具有真实 Harness identity 的已构建安装产物；产物先复制到私有 data-root 下的内容寻址不可变目录，再启动选择的业务宿主。短期业务能力 worker 清除继承的 `LOOP_*` 权限及数据库路由，仅重建自身实际安装和私有数据路径。版本从真实产物读取，不能传一个声称的版本号。

`npm run host:run` 现指向外部 root 源码，但同样必须提供 ABI 与执行器相容的已构建运行目录，不能直接把未经构建的源码目录当成安装产物。Electron ABI 的产物应使用实际 Electron 执行打包 CJS（见下段）。是否启动 Agent 取决于独立管理库的持久化意图；保存的 stop 只允许静默诊断宿主，不启动模型。不要用主工作区数据目录进行故障注入。

打包运行目录中的 native better-sqlite3 按 Electron ABI 构建，因此执行其独立 CJS 宿主时应提供真实 Electron 可执行文件，并为配置生成器传 `--electron-node true`。不能用 ABI 不兼容的全局 Node 代替。源码 / Node 构建的独立入口则使用匹配自身依赖的 Node。配置生成器也作为 `desktop-runners/host-configure.cjs` 打包，不依赖生产安装目录含有 tsx 或 TypeScript 源码。

## 生成配置

例如为 macOS 源码独立入口生成私有配置（所有占位路径都必须换成实际值）：

```sh
npm run host:configure -- \
  --platform darwin \
  --executable /absolute/node \
  --entry /absolute/source/scripts/compiled-host.cjs \
  --app-root /absolute/source \
  --data-root /absolute/private-data \
  --output-dir /absolute/new-service-config
```

entry 是实际可运行的 JS/CJS，不是直接交给裸 Node 的 `.ts` 文件。不传 `--entry` 时，standalone 默认取目标平台 `<app-root>/desktop-runners/external-host.cjs`；显式覆盖用于确实可运行的自定义入口。desktop target 使用 `--target desktop`，不传 entry / electron-node。

输出目录使用本机绝对路径。跨平台预览另传目标安装配置目录，例如在 macOS 预览 Windows 使用 `--config-root 'C:\LoopWorkData\host-service'`。返回 `registered:false`；已有同名文件用 wx 拒绝覆盖。失败时检查新生成目录，不能将部分生成等同于已安装。

只接受固定环境字段；不把整个调用者环境、API token 或 password 写进托管配置。显式 PATH 可用于独立入口找到既有配置的 CLI。Windows 桌面直接执行应用、继承交互用户环境，拒绝一个未实际应用的 PATH 覆盖。

## 平台启用与停止

启用前确认可执行文件 / 入口 / app-root 正确，data-root 已存在且属于运行用户。macOS 需要能在启动进程前打开 stdout / stderr 文件；缺少日志父目录会让 launchd 启动失败。

- macOS：先 `plutil -lint`，再将新 plist 放进当前用户 LaunchAgents 目录；使用 `launchctl bootstrap gui/<uid> <absolute-plist>`。KeepAlive 保持宿主运行，ThrottleInterval 默认 10 秒；`launchctl print gui/<uid>/<label>` 核对真实 PID。移除托管用准确 label 的 `launchctl bootout`，不能按进程名清理。参考 [Apple launchd 作业说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。
- Linux：放到当前用户 systemd user unit 目录后，`systemctl --user daemon-reload` 和 `enable --now <label>.service`；停止 / 禁用用同一准确 unit。使用 Restart=always、关闭启动频次熔断、10 秒重启间隔、45 秒停止期限和 KillMode=control-group。退出登录后继续运行需要单独配置 user manager lingering，不是这个文件自动授予的权限。ExecStart 使用 `:` 禁止环境变量替换，路径引号 / 反斜杠 / `%` 已转义；需要支持该前缀的 systemd。参考 [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)。
- Windows：由目标交互用户检查生成的 register.ps1，再执行其中注册命令；已有同名 task 会被拒绝，不使用 Force 覆盖。使用当前 SID、Limited / Interactive、IgnoreNew、无三天执行期限、允许电池持续运行。登录触发加每分钟周期触发，不依赖有限 RestartCount；省略 [RepetitionPattern.Duration](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-duration) 表示持续重复。完全停止托管需停止并取消这个准确 ScheduledTask；注销用户后 Interactive 任务不能假装仍然运行。

Windows standalone action 使用已生成内容的 EncodedCommand，不依赖执行未签名 `.ps1` 文件的客户端默认 execution policy；审计副本仍保留为 launch.ps1，修改副本不会修改已注册任务。包装进程将自己的实际 PID 传给宿主，宿主绑定启动父进程、每秒检查存活、每 30 秒异步复核创建身份；慢身份查询不阻塞廉价存活检查。父进程明确失效或读到不同启动标记时只关闭当前宿主，不杀一个被复用 PID 的其他进程。单次身份查询失败不是上述正面证据；连续查询失败超过有界阈值仍失败关闭。域策略、Constrained Language 或任务授权限制仍需对应系统证据，不能声称配置已通过真机验证。

停止 Loop 会终止业务和修复活动，托管宿主可保持待命。OS 作业被启用时，退出宿主本身会被重启；想完全退出托管，需先停用对应 OS 作业。应用更新静默不会授权启动新的 Agent。

## 诊断与退出

独立入口的 UTF-8 `data-root/host-service.log` 记录 pid、实际版本、初始化、fatal 和退出。`host-initialized` 明确不是业务恢复成功；不能拿这个日志或 systemd active 状态代替独立验收 / 正常业务推进。

SIGTERM / SIGINT 和受信任父进程私有 IPC 的 shutdown-host 都关闭宿主、保留用户意图。Windows 直接 force-terminate 不能假称触发了 SIGTERM hook；受信任控制进程应使用私有 IPC 做优雅切换。父 IPC 断开同样关闭宿主。30 秒内未完成实际清理时记录失败并以错误退出，OS 外层停止期限 45 秒；这不代表 CLI 后代已经退出，也不会删除退出屏障。仍需由后续宿主依据保存的真实进程身份确认。

## 当前验收边界

2026-09-16 新外部 root 的真实打包证明：`/tmp/loopwork-external-entry-proof.btrWIc/{evidence.json,verify.log,post-verify.log}`。两次停止意图下的正常重启、一轮双业务库损坏，均验证独立 root/管理租约实际续期、零模型调用、物理宿主与能力 worker 全部退出，管理屏障 exited；损坏字节、停止意图和不可变安装哈希保持不变。

新默认配置的真实临时 launchd 证明：`/tmp/loopwork-external-launchd-proof.zi6elj/{evidence.json,verify.log,post-verify.log}`。OS 实际替换被 SIGKILL 的 root，替代 root 先 observer，等待旧租约失效后接管并启动唯一静默业务宿主；不是把 OS 新 PID 等同于已经恢复。结束后只移除本次准确 label 的作业，独立只读复查实际 PID/进程组退出与租约清空。主工作区未启动 Loop 或额外 Web。

上述首次真实重启还暴露了业务租约删除导致代次重置的问题。现已保留释放租约的 fencing counter（清空 owner、立即过期），过期的同 owner 也不能复活原代次；历史来源重复时，audit 拒绝把某个 exited root 当成唯一来源。新产物在全新数据目录重跑：`/tmp/loopwork-fenced-entry-proof.TtPhxI/` 与 `/tmp/loopwork-fenced-launchd-proof.bpSQLQ/` 的 `verify.log`、`post-verify.log` 均退出 0，真实业务宿主代次明确为 `1 → 2`。OS 强杀至实际恢复约 37 秒；准确临时作业已移除，所有捕获 PID/进程组退出。源码 `ce19a31737d4132ef867a951605f003262f6a78007d11ceaa8fe002be31ebb39`，产物 `544d03cd3aeb0eb6b019b854c08ff8dddc75c5b61a300f0ab1017d4a6973afdf`。

本机 macOS 已实际 bootstrap 临时 launchd 作业，强杀宿主、观察新 PID、等待真实 30 秒租约失效、恢复缓存的独立 Admin，保持损坏业务库和原始 RepairCase 不变，再通过持久化用户停止取消 CLI。另验证被强杀包装进程后的独立宿主退出。所有作业使用独立私有数据目录，结束后 bootout；不安装生产服务、不启动额外 Web。

这些是受控 CLI / 原生进程证据，不是三条真实模型修复 / 业务验收；Windows Task Scheduler、Linux systemd 和真实桌面应用的 OS 重启需要对应环境验收。Windows Job Object / guardian、POSIX 脱离进程组的后代确认、外部候选切换 / 失败回滚 / 数据库兼容以及 8–12 小时验收仍属于完整目标，不因托管配置可生成而判定完成。
