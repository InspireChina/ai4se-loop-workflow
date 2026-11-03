/** 共享原始源码：由同目录命令入口调用。修改会作用于引用它的流程角色；不要在模块加载时执行任务副作用。 */
module.exports = function createDirectRuntime(harness) {
  const { agentResultSchema } = harness;
  function required(flags, name, max) {
      const value = flags.get(name)?.trim();
      if (!value)
          throw new Error(`缺少 --${name}-file`);
      if (value.length > max)
          throw new Error(`${name} 不能超过 ${max} 个字符`);
      return value;
  }
  /** Direct 的两步协议帮助；修改语法时与角色 Prompt 的说明保持一致。 */
  function directHelp() {
      return [
          'Direct Pipeline 只有两个命令：',
          '  direct run',
          '  direct submit --summary-file <简短结论> [--result-file <完整 Markdown 结果>]',
          '',
          '先执行 run，再完成真实工作，最后执行 submit。普通最终文本不会完成需求。',
          'summary 最多 4000 字符；result 最多 100000 字符。长文本文件必须位于 $LOOP_AGENT_TMP_DIR。',
      ].join('\n');
  }
  /** Direct 的实际 RUN / SUBMIT 状态操作；提交仍需结构化结果和活动 execution。 */
  function runDirectCommand(input) {
      const { db, execution, command, flags } = input;
      const state = db.prepare('SELECT * FROM direct_execution_state WHERE execution_id = ?')
          .get(execution.execution_id);
      if (command === 'direct run') {
          if (state?.submitted_at) {
              return '# DIRECT\n\n- Step: submit\n- Outcome: already_submitted\n- Agent Action: end_execution';
          }
          db.prepare(`
        INSERT OR IGNORE INTO direct_execution_state(execution_id)
        VALUES(?)
      `).run(execution.execution_id);
          return [
              '# DIRECT',
              '',
              '- Step: run',
              '- Outcome: ready',
              `- Requirement: ${execution.task_id}`,
              '- Next: 完成需求描述中的真实工作，然后执行 direct submit。',
          ].join('\n');
      }
      if (command === 'direct submit') {
          if (!state)
              throw new Error('必须先执行 direct run');
          if (state.submitted_at) {
              return '# DIRECT\n\n- Step: submit\n- Outcome: already_submitted\n- Agent Action: end_execution';
          }
          const summary = required(flags, 'summary', 4_000);
          const content = (flags.get('result')?.trim() || summary);
          if (content.length > 100_000)
              throw new Error('result 不能超过 100000 个字符');
          const result = agentResultSchema.parse({
              outcome: 'completed',
              summary,
              artifact: {
                  title: '直接执行结果',
                  content,
              },
          });
          db.transaction(() => {
              const updated = db.prepare(`
          UPDATE execution_attempts
          SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
          WHERE execution_id = ? AND status = 'running'
        `).run(JSON.stringify(result), execution.execution_id);
              if (updated.changes !== 1)
                  throw new Error(`当前 execution 状态为 ${execution.status}，不能提交结果`);
              db.prepare(`
          UPDATE direct_execution_state
          SET submitted_at = CURRENT_TIMESTAMP
          WHERE execution_id = ?
        `).run(execution.execution_id);
          })();
          return '# DIRECT\n\n- Step: submit\n- Outcome: submitted\n- Owner: Harness\n- Agent Action: end_execution';
      }
      throw new Error('Direct Pipeline 只支持 direct run 和 direct submit');
  }

  return { directHelp, runDirectCommand };
};
