# DJI Workflow 驱动入口

本目录只提供 Web 版本的 Runner、领域命令和维护 CLI，执行器固定为 OMP。

- `agent-runner.ts`：按事件与持久化状态派发原有 Workflow，维护并发、资源锁和错误恢复。
- `loop-agent.mjs`：execution 绑定的领域命令入口；校验凭证与阶段，读取临时输入文件并提交结果。
- `loop-agent-entry.ts`：领域命令的 TypeScript 入口。
- `loopctl.ts`：任务查询和维护 CLI。
- `submit-agent-result.mjs`：受控的执行结果通道。

通过仓库根目录 `./start.sh` 启动 Web/API 与 Runner 监督宿主。日常 CLI 可使用：

```sh
npm run loopctl -- --help
npm run db:migrate
```

OMP 通过原生 RPC 和 `loopwork` 工具调用授权的领域命令。Agent 的专业 Prompt 从唯一工作目录 `.omp/commands` 读取，不在服务内部维护；每个 Agent 的模型和思考强度仍可在 Web 中独立配置。

命令链由同一工作目录 `.omp/commands/<agent-id>.cjs` 的 API v1 接口驱动；各角色的实际校验与结果组装也在对应入口内。原始阶段、命令和状态操作源码公开在 `.omp/commands/workflow/*.cjs`。页面可编辑和保存这些文件；定义不写入数据库。详见 [脚本接口](../../docs/command-script-api.md)。

原有 Analysis / Delivery Lane、Dev/Test 隔离、独立证据、反馈和人工信息补充机制保持不变。普通 Agent 最终文本不会推进状态，必须提交并通过对应的领域门禁。

详见 [运行架构](../../docs/dji-architecture.md) 和 [启动说明](../../README.md)。

配套业务脚本放在工作目录 `scripts/`，由 `.omp` Skill 引用。检查结果留存示例见 [`../workflow/run-check.mjs`](../workflow/run-check.mjs)；现有命令链的阶段和完成门禁继续由本目录的领域命令管理。
