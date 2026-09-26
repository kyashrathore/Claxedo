import type { PluginManifest } from "@claxedo/plugin-api"
import { buildPluginApp } from "./build"
import { PluginBuildError, type PluginDiagnostic } from "./errors"
import { readPluginPackage } from "./manifest-file"
import { typecheckPlugin } from "./typecheck"

export type PluginCheck = Readonly<{
  ok: boolean
  manifest?: PluginManifest
  hash?: string
  diagnostics: readonly PluginDiagnostic[]
}>

export async function checkPluginApp(options: { rootDir: string }): Promise<PluginCheck> {
  try {
    const pkg = await readPluginPackage(options.rootDir)
    const diagnostics = await typecheckPlugin(pkg)
    if (diagnostics.length > 0) return { ok: false, manifest: pkg.manifest, diagnostics }
    const built = await buildPluginApp({ rootDir: options.rootDir })
    return { ok: true, manifest: built.manifest, hash: built.hash, diagnostics: [] }
  } catch (error) {
    if (error instanceof PluginBuildError) return { ok: false, diagnostics: error.diagnostics }
    throw error
  }
}
