/**
 * Node-bundle entry for the contract probes.
 *
 * `repairCoreLayerGraph` mirrors `../src/upstream-repair.ts` so a probe running
 * against the Node bundle exercises the same repair the product does. It is
 * deliberately opt-in: the diagnostic gates that DOCUMENT the failure
 * (gate-500-cause, repro-upstream) must keep failing, or the record of the bug
 * quietly disappears.
 */
export { OpenCode, Tool } from "@opencode-ai/sdk"

import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"

export function repairCoreLayerGraph() {
  const dependencies = FileSystem.node.dependencies
  const index = dependencies.findIndex((dependency) => dependency === undefined)
  if (index < 0) return { repaired: false }
  dependencies[index] = FileSystemSearch.node
  return { repaired: true, index }
}
