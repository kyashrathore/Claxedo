import fs from "node:fs"
import path from "node:path"

import {
  normalizeRollupBuildManifest,
  serializeBuildManifest,
  type RollupBundleMetadata,
} from "./normalize-build-manifest"

export type BuildManifestPluginOptions = {
  entry: string
  file: string
  workspaceRoot: string
}

/** A small Rollup-compatible plugin; kept free of a Vite dependency for reuse. */
export function productBoundaryBuildManifestPlugin(options: BuildManifestPluginOptions) {
  return {
    name: "claxedo-product-boundary-build-manifest",
    generateBundle(_outputOptions: unknown, bundle: RollupBundleMetadata) {
      const manifest = normalizeRollupBuildManifest({
        entry: options.entry,
        bundle,
        workspaceRoot: options.workspaceRoot,
      })
      fs.mkdirSync(path.dirname(options.file), { recursive: true })
      fs.writeFileSync(options.file, serializeBuildManifest(manifest))
    },
  }
}
