import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build as esbuild } from "esbuild"
import { pluginToolDeclarationsSchema, type PluginToolDeclaration } from "@claxedo/plugin-api/release"
import { bundleFailure, PluginBuildError } from "./errors"
import { PLUGIN_PACKAGE_FILE, type PluginPackage } from "./manifest-file"

async function definitionsEntry(pkg: PluginPackage, definitions: string): Promise<string> {
  const resolved = path.resolve(pkg.rootDir, definitions)
  const inside = path.relative(pkg.rootDir, resolved)
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new PluginBuildError("entry", [{ file: PLUGIN_PACKAGE_FILE, message: `claxedo.backend.tools.definitions must stay inside the package, got ${definitions}` }])
  }
  try {
    await fs.access(resolved)
  } catch {
    throw new PluginBuildError("entry", [{ file: PLUGIN_PACKAGE_FILE, message: `claxedo.backend.tools.definitions names ${definitions}, which does not exist` }])
  }
  return resolved
}

async function bundledDefinitions(pkg: PluginPackage, entry: string): Promise<string> {
  try {
    const result = await esbuild({
      entryPoints: [entry],
      absWorkingDir: pkg.rootDir,
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      target: "es2022",
      logLevel: "silent",
    })
    const output = result.outputFiles[0]
    if (!output) throw new PluginBuildError("bundle", [{ file: entry, message: "esbuild produced no output" }])
    return output.text
  } catch (error) {
    throw bundleFailure(error) ?? error
  }
}

/**
 * The tool declarations `claxedo.backend.tools.definitions` exports as its
 * default export, read by evaluating the bundled module once at build: the
 * release carries them as data, so no host ever runs the plugin's code to
 * learn which tools it serves.
 */
export async function extractPluginTools(pkg: PluginPackage): Promise<readonly PluginToolDeclaration[] | undefined> {
  const declared = pkg.manifest.backend?.tools
  if (!declared) return undefined
  const entry = await definitionsEntry(pkg, declared.definitions)
  const code = await bundledDefinitions(pkg, entry)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-tools-"))
  const file = path.join(directory, "tools.mjs")
  let exported: unknown
  try {
    await fs.writeFile(file, code)
    const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(file).href)
    exported = loaded !== null && typeof loaded === "object" && "default" in loaded ? loaded.default : undefined
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
  const parsed = pluginToolDeclarationsSchema.safeParse(exported)
  if (parsed.success) return parsed.data
  throw new PluginBuildError(
    "bundle",
    parsed.error.issues.map((issue) => ({ file: declared.definitions, message: `default export${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}` })),
  )
}
