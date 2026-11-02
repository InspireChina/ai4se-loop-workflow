import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import register from '../../scripts/omp-extension.mjs';

const keys = ['LOOP_CONTEXT_CHAT_COMMAND_TOKEN', 'LOOP_EXECUTION_TOKEN', 'LOOP_APP_ROOT', 'LOOP_NODE', 'LOOP_AGENT_TMP_DIR'] as const;
test('native workflow tool requires credentials, passes literal arguments without a shell, and removes temporary input', async () => {
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    let tool: any;
    register({ zod: z, registerTool: (value: unknown) => { tool = value; } });
    assert.equal(tool, undefined);
    mkdirSync(process.env.LOOP_DATA_ROOT!, { recursive: true });
    const root = mkdtempSync(join(process.env.LOOP_DATA_ROOT!, 'extension-'));
    mkdirSync(join(root, 'scripts', 'loop'), { recursive: true });
    const temp = join(root, 'input');
    writeFileSync(join(root, 'scripts', 'loop', 'loop-agent.mjs'), `
      import {readFileSync} from 'node:fs';
      const args=process.argv.slice(2);
      if(args[0]==='rejected')console.log('Outcome: rejected\\nAuthorization denied');
      else console.log(JSON.stringify({args,body:readFileSync(args.at(-1),'utf8')}));
    `);
    Object.assign(process.env, { LOOP_EXECUTION_TOKEN: 'test-token', LOOP_APP_ROOT: root, LOOP_NODE: process.execPath, LOOP_AGENT_TMP_DIR: temp });
    register({ zod: z, registerTool: (value: unknown) => { tool = value; } });
    const payload = 'UTF-8 文档';
    const sentinel = join(root, 'must-not-exist');
    const output = await tool.execute('call', { args: ['direct', 'submit', '--summary', `$(touch ${sentinel})`, '--result-file', '@input'], input: payload });
    const result = JSON.parse(output.content[0].text);
    assert.equal(result.body, payload);
    assert.equal(result.args[3], `$(touch ${sentinel})`);
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(readdirSync(temp), []);
    await assert.rejects(tool.execute('bad', { args: ['rejected'] }), /Authorization denied/);
    process.env.LOOP_CONTEXT_CHAT_COMMAND_TOKEN = 'chat-token';
    register({ zod: z, registerTool: (value: unknown) => { tool = value; } });
    await assert.rejects(tool.execute('mutate', { args: ['direct', 'submit'] }), /cannot call/);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
