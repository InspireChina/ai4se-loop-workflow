import type { AdminControllerPorts } from '../application/admin-controller';
import type { AdminManagementStore } from './admin-management-store';
import { readHarnessArtifact } from '../../scripts/harness-artifact.mjs';
import { sanitizeDiagnosticText } from './diagnostic-text';

/** Resolve actual root-owned immutable command bytes before any child launch.
 * A damaged selected business bundle must not remove its repairer's tools.
 * Failures here prove no spawn; failures in the delegated launch do not. */
export function createManagementToolLaunch(ports: {
  store: AdminManagementStore;
  rootOwnerId: string;
  launch: (toolRoot: string) => AdminControllerPorts['launch'];
}): AdminControllerPorts['launch'] {
  return async (claim, bind, signal) => {
    let toolRoot: string;
    try {
      const authority = ports.store.runtimeHostAuthority(ports.rootOwnerId);
      const artifact = ports.store.runtimeHostArtifact(authority);
      if (!artifact) throw new Error('管理工具缺少当前 root 的不可变产物绑定');
      const check = () => {
        signal.throwIfAborted();
        ports.store.assertRuntimeHost(authority);
        ports.store.readCommandSubmission(claim);
        if (JSON.stringify(ports.store.runtimeHostArtifact(authority)) !== JSON.stringify(artifact)) {
          throw new Error('管理工具验证期间 root 产物绑定改变');
        }
      };
      check();
      const actual = await readHarnessArtifact(artifact.root, { signal, assertCurrent: check });
      check();
      if (JSON.stringify(actual) !== JSON.stringify(artifact)) throw new Error('管理工具实际产物不匹配');
      toolRoot = actual.root;
    } catch (error) {
      return { completion: Promise.resolve({ outcome: 'failed', exitConfirmed: true,
        reason: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) }), stop: async () => true };
    }
    return ports.launch(toolRoot)(claim, bind, signal);
  };
}
