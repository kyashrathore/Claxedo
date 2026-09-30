import { build as esbuild } from "esbuild"
import type { PluginBackend, PluginManifest } from "@claxedo/plugin-api"
import { bundleFailure, PluginBuildError } from "./errors"
import { readPluginPackage } from "./manifest-file"

export type PluginBackendBuild = {
  manifest: PluginManifest & { backend: PluginBackend }
  code: string
}

/**
 * Bundles `claxedo.backend.entry` into the one ES module the hosted Worker
 * loads through its Worker Loader. Only `cloudflare:*` stays external: the
 * loaded Worker runs without `nodejs_compat`, so a `node:` import fails here
 * rather than at load.
 */
export async function buildPluginBackend(options: { rootDir: string }): Promise<PluginBackendBuild> {
  const pkg = await readPluginPackage(options.rootDir)
  const backend = pkg.manifest.backend
  if (!backend || !pkg.backendEntry) {
    throw new PluginBuildError("entry", [{ file: "package.json", message: "claxedo.backend is not declared" }])
  }
  let result
  try {
    result = await esbuild({
      entryPoints: [pkg.backendEntry],
      absWorkingDir: pkg.rootDir,
      bundle: true,
      write: false,
      metafile: true,
      outfile: "backend.js",
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*"],
      target: "es2022",
      legalComments: "none",
      logLevel: "silent",
    })
  } catch (error) {
    throw bundleFailure(error) ?? error
  }
  const output = result.outputFiles[0]
  const exports = Object.values(result.metafile.outputs)[0]?.exports ?? []
  if (!output) throw new PluginBuildError("bundle", [{ file: backend.entry, message: "esbuild produced no output" }])
  const missing = ["default", ...backend.objects].filter((name) => !exports.includes(name))
  if (missing.length > 0) {
    throw new PluginBuildError(
      "bundle",
      missing.map((name) => ({
        file: backend.entry,
        message: name === "default" ? "the backend entry has no default export" : `claxedo.backend.objects names ${name}, which the entry does not export`,
      })),
    )
  }
  return { manifest: { ...pkg.manifest, backend }, code: output.text }
}
