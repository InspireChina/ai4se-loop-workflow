import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandChainCatalogItem } from '../domain/command-chain-catalog';
import { appDatabaseConnection, hash, paths } from './database';

export type BundledCommandChainConfiguration = 'default' | 'openspec';

export function bundledCommandChainYaml(commandChainId: string, configuration: BundledCommandChainConfiguration = 'default') {
  const item = commandChainCatalogItem(commandChainId);
  if (!item) throw new Error(`未知命令链：${commandChainId}`);
  return readFileSync(join(paths.appRoot, 'command-chains', configuration, item.fileName), 'utf8').trimEnd() + '\n';
}

export function hasBundledCommandChainYaml(commandChainId: string, configuration: BundledCommandChainConfiguration) {
  const item = commandChainCatalogItem(commandChainId);
  return Boolean(item && existsSync(join(paths.appRoot, 'command-chains', configuration, item.fileName)));
}

export function activeCommandChainYaml(commandChainId: string) {
  const item = commandChainCatalogItem(commandChainId);
  if (!item) return null;
  const db = appDatabaseConnection();
  const row = db.prepare(`
    SELECT configuration.configuration_id, configuration.name, configuration.builtin_key,
           document.yaml_content, document.content_hash, document.revision,
           document.system_managed
    FROM agent_configuration_sets configuration
    JOIN agent_configuration_documents document ON document.configuration_id = configuration.configuration_id
    WHERE configuration.agent_id = ? AND configuration.is_active = 1
      AND document.command_chain_id = ?
  `).get(item.agentId, commandChainId) as {
    configuration_id: string;
    name: string;
    builtin_key: string | null;
    yaml_content: string;
    content_hash: string;
    revision: number;
    system_managed: number;
  } | undefined;
  if (row?.system_managed) {
    const bundledConfiguration = row.builtin_key === 'openspec' ? 'openspec' : 'default';
    const bundled = bundledCommandChainYaml(commandChainId, bundledConfiguration);
    const bundledHash = hash(bundled);
    if (row.content_hash !== bundledHash) {
      db.prepare(`
        UPDATE agent_configuration_documents
        SET yaml_content = ?, content_hash = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE configuration_id = ? AND command_chain_id = ? AND system_managed = 1
      `).run(bundled, bundledHash, row.configuration_id, commandChainId);
      return bundled;
    }
  }
  return row?.yaml_content || bundledCommandChainYaml(commandChainId);
}
