import { cp } from 'node:fs/promises';

/**
 * Copy a completed Next build out of its disposable source snapshot.
 *
 * Next's standalone output contains package aliases implemented as symbolic
 * links. Preserving those links would either require Windows symlink
 * privileges or leave links pointing back into the snapshot after it is
 * deleted. Materialize their targets so the returned build is self-contained.
 */
export async function copyHarnessBuildOutput(source, destination) {
  await cp(source, destination, { recursive: true, dereference: true });
}
