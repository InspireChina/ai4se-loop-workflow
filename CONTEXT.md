# LoopWork DJI

本分支是面向 DJI 的单工作目录 Web 版本，只通过 OMP 驱动既有 Workflow。

- 保留原有 Workflow 角色、Pipeline、阶段、权限、幂等和独立验证，不自动增加角色。
- 角色定义从启动工作目录 `.omp/commands` 动态读取；业务知识、规则和模板引用由外部 Agent / Skill 维护。
- 命令链直接加载 `.omp/commands/<agent-id>.cjs` 源码。API v1 约定角色、describe、initialize、execute、validate、result、restore、help；原有共享实现源码在 `.omp/commands/workflow/*.cjs`，页面可编辑保存。Direct 保留 executeDirect，Feedback 同一脚本提供两条链。
- 每个 Agent 可独立设置 OMP 模型和思考强度。显式配置优先于外部定义，未设置字段继续继承。
- OMP 原生 RPC 管理模型循环、工具、Skill、会话和压缩；LoopWork 管理任务状态、授权领域命令、执行监督与结果应用。
- 一个实例只绑定一个启动工作目录；不提供多项目管理或切换。
- SQLite 保存 Workflow 状态、索引和文件引用；正文、日志、对话和执行快照保存为文件。
- Web 宿主维护持续运行意图、监督租约和代次。Runner 根据事件派发工作，停止与恢复依赖持久化事实。
- 任务暂停不同于停止 Loop；Dev/Test 的代码锁、上下文隔离和证据门禁仍由原 Workflow 保证。

启动与验证见 [README](README.md)，实现边界见 [DJI 架构](docs/dji-architecture.md)。

- 决策草稿和任务级决策树的完整内容写入所选文件目录 `<taskId>/decisions/<kind>/<scopeId>/<hash>.json`，节点内容列只存带签名的文件字段引用。SQL 保留状态与身份索引，原有命令、人工回答、恢复和分支逻辑继续使用同一协议。
