import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { COMMAND_CHAIN_CATALOG } from './command-chain-catalog';
import { parseCommandChainDefinition } from './command-chain-definition';
import {
  BUILTIN_PHASE_IDS,
  commandChainRegistry,
  CommandChainRegistry,
} from './command-chain-registry';

const command = {
  id: 'decision.put',
  tokens: ['decision', 'put'] as const,
  kind: 'write' as const,
  usage: 'decision put --tree <id> --key <key> --content-file <yaml>',
  summary: '登记决策',
};

test('registers and resolves the longest matching command syntax', () => {
  const registry = new CommandChainRegistry();
  registry.registerCommand(command);
  registry.registerCommand({
    id: 'decision.put.preview',
    tokens: ['decision', 'put', 'preview'],
    kind: 'read',
    usage: 'decision put preview',
    summary: '预览决策',
  });

  assert.equal(registry.resolveCommand(['decision', 'put', '--key', 'a'])?.id, 'decision.put');
  assert.equal(registry.resolveCommand(['decision', 'put', 'preview'])?.id, 'decision.put.preview');
  assert.equal(registry.resolveCommand(['decision', 'remove']), null);
});

test('rejects duplicate command ids, syntaxes, and builtin ids', () => {
  const registry = new CommandChainRegistry();
  registry.registerCommand(command);
  assert.throws(() => registry.registerCommand(command), /重复注册命令/);
  assert.throws(() => registry.registerCommand({ ...command, id: 'decision.create' }), /重复注册命令语法/);

  const builtin = {
    id: 'decision-proposal',
    label: 'DECISION TREE · PROPOSE',
    acceptsArtifacts: false,
    compile: () => ({}) as never,
  };
  registry.registerBuiltin(builtin);
  assert.throws(() => registry.registerBuiltin(builtin), /重复注册内置 Phase/);
});

test('registers the complete builtin phase and command inventories', () => {
  assert.deepEqual(
    commandChainRegistry.builtins().map(({ id }) => id).sort(),
    [...BUILTIN_PHASE_IDS].sort(),
  );
  assert.equal(commandChainRegistry.commands().length, 21);
});

test('resolves every builtin and phase command used by bundled YAML', () => {
  const appRoot = process.env.LOOP_APP_ROOT || process.cwd();
  const referencedBuiltins = new Set<string>();
  for (const configuration of ['default', 'openspec']) {
    for (const item of COMMAND_CHAIN_CATALOG) {
      const path = join(appRoot, 'command-chains', configuration, item.fileName);
      if (!existsSync(path)) continue;
      const definition = parseCommandChainDefinition(item.id, readFileSync(path, 'utf8'));
      for (const phase of Object.values(definition.phases)) {
        if (phase.builtin) {
          referencedBuiltins.add(phase.builtin);
          assert.equal(phase.title, commandChainRegistry.builtin(phase.builtin)?.label);
        }
        for (const usage of phase.commands) {
          assert.ok(
            commandChainRegistry.resolveCommand(usage.trim().split(/\s+/)),
            `${configuration}/${item.fileName} 引用了未注册命令：${usage}`,
          );
        }
      }
    }
  }
  assert.deepEqual([...referencedBuiltins].sort(), [...BUILTIN_PHASE_IDS].sort());
});
