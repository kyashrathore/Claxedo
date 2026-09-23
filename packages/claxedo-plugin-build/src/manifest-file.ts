import fs from "node:fs/promises"
import path from "node:path"
import { PluginManifestError, readPluginManifest, type PluginManifest } from "@claxedo/plugin-api"
import { PluginBuildError } from "./errors"

export type PluginPackage = {
  rootDir: string
  packageJsonPath: string
  manifest: PluginManifest
  appEntry: string
}

async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    throw new PluginBuildError("manifest", [`${file}: ${error instanceof Error ? error.message : String(error)}`])
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new PluginBuildError("manifest", [`${file}: ${error instanceof Error ? error.message : String(error)}`])
  }
}

export async function readPluginPackage(rootDir: string): Promise<PluginPackage> {
  const packageJsonPath = path.join(rootDir, "package.json")
  const packageJson = await readJson(packageJsonPath)
  let manifest: PluginManifest
  try {
    manifest = readPluginManifest(packageJson)
  } catch (error) {
    if (error instanceof PluginManifestError) throw new PluginBuildError("manifest", error.issues.map((issue) => `${packageJsonPath}: ${issue}`))
    throw error
  }
  const appEntry = path.resolve(rootDir, manifest.app)
  const inside = path.relative(rootDir, appEntry)
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new PluginBuildError("entry", [`${packageJsonPath}: claxedo.app must stay inside the package, got ${manifest.app}`])
  }
  try {
    await fs.access(appEntry)
  } catch {
    throw new PluginBuildError("entry", [`${packageJsonPath}: claxedo.app names ${manifest.app}, which does not exist`])
  }
  return { rootDir, packageJsonPath, manifest, appEntry }
}
