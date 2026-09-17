import path from "node:path"

import {
  normalizeRollupEntryBuildManifest,
  type RollupBundleMetadata,
} from "../../../script/product-boundary/normalize-build-manifest"

/**
 * Chunks a worker may reach must never import `electron`. The workers are
 * spawned from the Electron binary with ELECTRON_RUN_AS_NODE=1, where the
 * `electron` module resolves to a bare path string: any named import fails at
 * module instantiation, before the worker reads a single request, and the
 * main process only sees "source-failed".
 */
export function verifyNodeWorkerBundles(input: {
  bundle: RollupBundleMetadata
  workspaceRoot: string
  workerEntries: string[]
}) {
  const failures = input.workerEntries.flatMap((entry) => {
    const manifest = normalizeRollupEntryBuildManifest({ entry, bundle: input.bundle, workspaceRoot: input.workspaceRoot })
    const electronEdges = manifest.edges.static.filter((edge) => edge.endsWith(" -> electron"))
    return electronEdges.length === 0 ? [] : [`${manifest.entry}: ${electronEdges.join(", ")}`]
  })
  if (failures.length > 0) {
    throw new Error(`node worker bundles reach electron:\n${failures.map((line) => `  ${line}`).join("\n")}`)
  }
}

export function desktopNodeWorkerBundlePlugin(input: { desktopRoot: string; workerEntries: string[] }) {
  const workspaceRoot = path.resolve(input.desktopRoot, "../..")
  const workerEntries = input.workerEntries.map((entry) => path.join(input.desktopRoot, entry))
  return {
    name: "claxedo-desktop-node-worker-bundles",
    generateBundle(_outputOptions: unknown, bundle: RollupBundleMetadata) {
      verifyNodeWorkerBundles({ bundle, workspaceRoot, workerEntries })
    },
  }
}
