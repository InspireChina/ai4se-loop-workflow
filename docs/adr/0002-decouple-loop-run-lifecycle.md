# 解耦 Loop 运行生命周期

## 决策

引入独立的 Loop 运行生命周期 module，统一解释持久化意图、更新静默、实际运行状态和受管进程事实。UI、Electron 与未来 CLI 是调用入口；Runner 是该 module 管理的后台 worker，不是与调用入口同级的 interface。

对外 interface 只提供三个入口：

```ts
interface LoopRunLifecycle {
  command(input: LifecycleCommand): Promise<LifecycleReceipt>;
  reconcile(input: ReconcileTrigger): Promise<LifecycleReceipt>;
  status(): Promise<LifecycleSnapshot>;
}
```

- `command` 完整协调 `start`、`stop`、`prepare-update` 和 `resume-after-update`，并以 `requestId` 保证幂等。
- `reconcile` 在宿主启动、周期检查、进程退出或人工诊断时，使实际状态收敛到持久化事实；它不得改变用户意图。
- `status` 返回稳定的生命周期快照，普通状态不暴露进程细节；更新被阻止时可以返回经过验证的残留进程身份供诊断。

UI 只依赖 `LifecycleClient` interface。桌面 implementation 使用 Electron preload IPC，浏览器开发环境可以使用本地 HTTP adapter。UI 不直接接触 Electron、数据库、PID 或 Runner。Next Server 只承担 UI Server 与浏览器 adapter，不再拥有 Runner：

```text
UI ── LifecycleClient adapter ──┐
Electron ───────────────────────┼── LoopRunLifecycle ── Runner ── Agent CLI
CLI ────────────────────────────┘

Electron
├── LoopRunLifecycle / ProcessHost adapter
└── optional UI Server
```

当前由 Electron 作为监督宿主并直接加载 lifecycle module；未来 CLI 可以加载同一 module，在没有 Electron 和 UI Server 时独立运行。Electron 与 CLI 可以共存，但持久化监督租约保证同一时刻只有一个宿主能够监督和创建 Runner。租约暂定 30 秒，接管时产生更高的 fencing token；任何旧代次都不能再启动、重启或登记进程。

## 持久化事实

生命周期保存三组彼此正交的事实：

1. 用户意图：`running | stopped`，附带单调递增的 revision。
2. 运行模式：`normal | update-silence`，更新静默附带 `attemptId`、`targetVersion` 和 readiness。
3. 实际运行：`starting | running | stopping | stopped | crashed`，附带健康状态、失败次数和下次重试时间。

最后提交的明确用户意图生效。相同 `requestId` 的重复 command 返回原 receipt，不重复执行。进入更新流程后冻结普通操作；`start` 和 `stop` 返回 `update-in-progress`，也不改变保存的意图。只有目标新版本确认更新成功，或更新失败后用户明确重试或恢复使用，才能离开更新静默。

任何状态写入失败都按失败关闭处理。没有持久化身份的后台进程不得继续运行；更新静默无法持久化时不得开始安装。

## 进程所有权与恢复

UI Server、Runner 和 Agent CLI 必须通过 ProcessHost adapter 创建，并属于明确的监督代次。Runner 不再作为无人负责的 detached 进程跨越监督宿主生命周期；窗口关闭到托盘不结束 Electron，因此不影响 Runner。监督宿主正常退出时会精确终止受管进程树；若宿主崩溃，Runner 会在 30 秒租约失效并经过 15 秒休眠宽限后自行退出，再由新宿主依据草稿和执行事实恢复。

进程登记至少保存 PID、操作系统进程启动时间、进程种类和监督 token。任何终止操作都必须先由 OS adapter 验证身份：身份匹配才终止；PID 不存在则视为已清理；PID 已被复用则只清除过期登记；无法验证时进入 blocked，禁止按进程名批量清理。

Runner 崩溃后在持续运行意图仍为 `running` 时自动恢复，退避顺序暂定为 5 秒、15 秒、30 秒，随后最多每 5 分钟一次。健康运行 10 分钟后清零失败计数。每次恢复前重新检查意图 revision、更新静默和监督 token。系统从休眠唤醒时给予原 Runner 15 秒恢复心跳；若已有更高监督代次，旧宿主及旧 Runner 必须退出。

## 停止与退出

停止 Loop 采用立即终止：先持久化 `stopped` 意图，再结束 Runner 与 Agent CLI，并按已有草稿和执行结果恢复未完成工作。少量重复工作可以接受。

- 关闭窗口：隐藏到托盘，Loop 继续。
- 明确选择退出或使用 `Cmd/Ctrl + Q`：停止 Loop 并清除持续运行意图。
- 系统关机、重启或注销：结束受管进程但保留意图。
- 应用崩溃或被强制结束：不改写意图，由租约与下次启动恢复。
- 意图变为 `running` 时注册登录后隐藏启动；明确停止时取消注册。注册失败不阻止当前启动，但必须在 receipt 和状态中报告无法保证跨重启恢复。

## 更新门禁

`prepare-update` 先持久化更新静默，再停止监督和全部后台活动。所有登记进程及其子进程经过 OS adapter 验证为已经消失后，才能返回 `ready-for-update`。超时或身份无法验证时返回 `blocked`，不得启动安装，也不得自动恢复 Loop。

旧版本退出前不得清除更新静默。只有启动版本与 `targetVersion` 相符的新宿主才能确认该 `attemptId`、解除静默，并按保存的持续运行意图恢复。安装失败或仍启动旧版本时继续保持静默，等待用户重试更新或明确恢复使用。

## 升级

升级保留需求、草稿、执行结果、运行日志和持续运行意图。首次启动新版本时不接管旧 detached Runner，而是进入 `legacy-cleanup`：验证并终止能够确认为 LoopWork 所有的旧进程，将未完成执行恢复为可重试，再创建新的监督代次。如果旧进程无法验证或清理，则显示 `blocked-by-legacy-process`，不启动新 Runner。

自主软件维护数据按 ADR 0001 直接删除，不参与生命周期迁移。

## 后果

UI、Electron、CLI 与 Runner 的职责不再混合；移除 UI 或 Next Server 后，CLI 仍可驱动同一生命周期。代价是需要实现持久化租约、fencing token、跨平台 ProcessHost adapter、进程身份验证和更完整的故障测试，但这些机制集中在一个较深的 module 内，不向 UI 或 Runner 泄漏。
