import fs from "node:fs/promises"
import path from "node:path"
import type { AppPluginsGrant } from "@claxedo/mcp/client"
import { checkPluginApp } from "@claxedo/plugin-build"
import { AppPluginAuthoringError, appPluginScaffold } from "./scaffold"
import { livePluginService, type LivePluginService } from "./service"

export const APP_PLUGIN_FOLDER = path.join(".claxedo", "plugins")

export type AppPluginAuthoringOptions = {
  roots: readonly string[]
  service?: () => LivePluginService
}

async function exists(file: string) {
  return fs.lstat(file).then(() => true, () => false)
}

async function realPathAllowingMissing(target: string): Promise<string> {
  const missing: string[] = []
  let current = target
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function appPluginAuthoring(options: AppPluginAuthoringOptions): AppPluginsGrant {
  const service = options.service ?? livePluginService
  if (options.roots.length === 0) throw new Error("App plugin authoring needs at least one folder the session may write")

  const resolveInside = async (directory: string): Promise<string> => {
    if (!path.isAbsolute(directory)) throw new AppPluginAuthoringError(`${directory} is not an absolute path`)
    const real = await realPathAllowingMissing(path.resolve(directory))
    const roots = await Promise.all(options.roots.map((root) => realPathAllowingMissing(root)))
    if (!roots.some((root) => isInside(root, real))) {
      throw new AppPluginAuthoringError(`${directory} is outside this session's workspace (${options.roots.join(", ")})`)
    }
    return real
  }

  const existingFolder = async (directory: string): Promise<string> => {
    const real = await resolveInside(directory)
    const stat = await fs.stat(real).catch(() => undefined)
    if (!stat) throw new AppPluginAuthoringError(`${directory} does not exist`)
    if (!stat.isDirectory()) throw new AppPluginAuthoringError(`${directory} is not a folder`)
    return real
  }

  return {
    async create(input) {
      const { manifest, files } = appPluginScaffold(input.name)
      const [root = ""] = options.roots
      const target = await resolveInside(input.directory ?? path.join(root, APP_PLUGIN_FOLDER, manifest.id))
      if ((await exists(target)) && (await fs.readdir(target)).length > 0) {
        throw new AppPluginAuthoringError(`${target} already exists and is not empty; choose another name or folder`)
      }
      await service().ready
      const registered = service().list().find((row) => row.id === manifest.id)
      if (registered) {
        throw new AppPluginAuthoringError(`A plugin with id ${manifest.id} is already registered from ${registered.directory}; choose another name`)
      }
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(target, name)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content, { flag: "wx" })
      }
      return { id: manifest.id, name: manifest.name, directory: target, files: Object.keys(files) }
    },
    async check(directory) {
      const real = await existingFolder(directory)
      const checked = await checkPluginApp({ rootDir: real })
      return { directory: real, ok: checked.ok, ...(checked.manifest ? { pluginId: checked.manifest.id } : {}), diagnostics: checked.diagnostics }
    },
    async add(directory) {
      const real = await existingFolder(directory)
      await service().ready
      const row = await service().add(real)
      return { id: row.id, name: row.name, directory: row.directory, status: row.status, lastError: row.lastError }
    },
  }
}
