import fs from "node:fs/promises"
import path from "node:path"
import { realPathAllowingMissing } from "@claxedo/helpers/real-path"
import type { AppPluginsGrant } from "@claxedo/mcp/client"
import { checkPluginApp } from "@claxedo/plugin-build"
import { AppPluginAuthoringError, appPluginScaffold } from "./scaffold"
import { livePluginService, type LivePluginService } from "./service"

export const APP_PLUGIN_FOLDER = path.join(".claxedo", "plugins")

export type AppPluginAuthoringOptions = {
  roots: readonly string[]
  /**
   * Asked again on every call: an MCP connection outlives the turn it opened
   * in, and a session may be handed to someone else between two of its calls.
   */
  ownerDriven: () => boolean
  service?: () => LivePluginService
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function appPluginAuthoring(options: AppPluginAuthoringOptions): AppPluginsGrant {
  const service = options.service ?? livePluginService
  if (options.roots.length === 0) throw new Error("App plugin authoring needs at least one folder the session may write")

  const resolveInside = (directory: string): string => {
    if (!options.ownerDriven()) {
      throw new AppPluginAuthoringError("Only sessions driven by this machine's owner may make app plugins")
    }
    if (!path.isAbsolute(directory)) throw new AppPluginAuthoringError(`${directory} is not an absolute path`)
    const real = realPathAllowingMissing(directory)
    const roots = options.roots.map(realPathAllowingMissing)
    if (!roots.some((root) => isInside(root, real))) {
      throw new AppPluginAuthoringError(`${directory} is outside this session's workspace (${options.roots.join(", ")})`)
    }
    return real
  }

  const existingFolder = async (directory: string): Promise<string> => {
    const real = resolveInside(directory)
    const stat = await fs.stat(real).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) throw new AppPluginAuthoringError(`${directory} does not exist`)
    if (!stat.isDirectory()) throw new AppPluginAuthoringError(`${directory} is not a folder`)
    return real
  }

  return {
    allowed: options.ownerDriven,
    async create(input) {
      const { manifest, files } = appPluginScaffold(input.name)
      const [root = ""] = options.roots
      const target = resolveInside(input.directory ?? path.join(root, APP_PLUGIN_FOLDER, manifest.id))
      if ((await fs.readdir(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })).length > 0) {
        throw new AppPluginAuthoringError(`${target} already exists and is not empty; choose another name or folder`)
      }
      await service().ready
      const registered = service().list().find((row) => row.id === manifest.id)
      if (registered) {
        throw new AppPluginAuthoringError(`A plugin with id ${manifest.id} is already registered from ${registered.directory}; choose another name`)
      }
      resolveInside(target)
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
      resolveInside(real)
      const row = await service().add(real)
      return { id: row.id, name: row.name, directory: row.directory, status: row.status, lastError: row.lastError }
    },
  }
}
