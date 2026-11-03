/**
 * 直接执行：维持 RUN → SUBMIT 两步提交协议。
 *
 * 给维护同事：OMP 原生入口是 /direct-agent，专业 Prompt 在同目录 direct-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: 'direct-agent',
  /** 向 Workflow 描述当前链及阶段顺序，不在此执行任务或产生外部副作用。
   * define 复用 workflow/definitions.cjs 的默认构造与结构检查。
   * 修改步骤顺序、字段或阶段指令后，同步检查同名 Markdown 的专业职责。
   * Flow 角色、Pipeline 和链 ID 仍由调度契约绑定；实际阶段以 status 返回为准。 */
  describe() { return []; },
  /** 执行已授权的 direct run / direct submit。
   * run 只开启本次工作，submit 成功才提交结构化结果；普通总结不能完成任务。 */
  executeDirect(runtime, invocation) {
    return runtime.runDirectCommand(invocation);
  },
  /** 返回协议帮助。命令语法调整时同步修改共享帮助与工作包，避免 Prompt 使用旧命令。 */
  help(runtime) { return runtime.directHelp(); },
};
