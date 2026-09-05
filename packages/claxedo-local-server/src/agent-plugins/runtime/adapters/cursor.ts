import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { writeProjectedMcpFile } from "./mcp-projection"

const OWNER = "claxedo-agent-plugins"
const PREFIX = "claxedo--"
const MARKER = ".claxedo-agent-plugin.json"

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function errorCode(value: unknown): string | undefined {
  return record(value) && typeof value.code === "string" ? value.code : undefined
}

function managedName(plugin: GenerationPluginRoot) {
  const readable = plugin.plugin.manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "plugin"
  const identity = crypto.createHash("sha256").update(plugin.pluginInstanceId).digest("hex").slice(0, 12)
  return `${PREFIX}${readable}--${identity}`
}

async function ownedDirectory(root: string, name: string) {
  if (!name.startsWith(PREFIX)) return false
  try {
    const marker = JSON.parse(await fs.readFile(path.join(root, name, MARKER), "utf8")) as unknown
    return record(marker)
      && marker.owner === OWNER
      && marker.directory === name
  } catch {
    return false
  }
}

/**
 * Cursor's public SDK can enable its plugin setting source, but it cannot take
 * arbitrary plugin roots. Its supported local contract is one plugin per
 * immediate child of ~/.cursor/plugins/local, so this adapter maintains only
 * a marker-owned namespace there and leaves every user-owned entry untouched.
 */
export function cursorAgentPluginAdapter(input: { userHomeDirectory?: string } = {}): AgentPluginHarnessProjectionAdapter {
  const localRoot = path.join(input.userHomeDirectory ?? os.homedir(), ".cursor", "plugins", "local")
  return {
    harnessId: "cursor",
    projectEmpty: true,
    async project({ plugins, mcpServers = [] }) {
      await fs.mkdir(localRoot, { recursive: true })
      const existingNames = await fs.readdir(localRoot)
      const existingManaged = new Set<string>()
      for (const name of existingNames) {
        if (await ownedDirectory(localRoot, name)) existingManaged.add(name)
      }

      const desired = new Map(plugins.map((plugin) => [managedName(plugin), plugin] as const))
      const transaction = crypto.randomUUID()
      const staged = new Map<string, string>()
      const backups = new Map<string, string>()
      const activated = new Set<string>()
      try {
        for (const [name, plugin] of desired) {
          const destination = path.join(localRoot, name)
          if (!existingManaged.has(name)) {
            try {
              await fs.lstat(destination)
              throw new Error(`Cursor plugin destination ${destination} is not owned by Claxedo`)
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error
            }
          }
          const staging = path.join(localRoot, `.claxedo-staging-${transaction}-${name.slice(PREFIX.length)}`)
          await fs.cp(plugin.root, staging, { recursive: true, dereference: true, force: false, errorOnExist: true })
          await writeProjectedMcpFile(staging, plugin, mcpServers)
          await fs.writeFile(path.join(staging, MARKER), `${JSON.stringify({
            owner: OWNER,
            directory: name,
            pluginInstanceId: plugin.pluginInstanceId,
          }, null, 2)}\n`)
          staged.set(name, staging)
        }

        for (const name of existingManaged) {
          const backup = path.join(localRoot, `.claxedo-backup-${transaction}-${name.slice(PREFIX.length)}`)
          await fs.rename(path.join(localRoot, name), backup)
          backups.set(name, backup)
        }
        for (const [name, staging] of staged) {
          await fs.rename(staging, path.join(localRoot, name))
          activated.add(name)
        }
      } catch (error) {
        await Promise.all([...staged.values()].map((staging) => fs.rm(staging, { recursive: true, force: true })))
        await Promise.all([...activated].map((name) => fs.rm(path.join(localRoot, name), { recursive: true, force: true })))
        for (const [name, backup] of backups) {
          await fs.rename(backup, path.join(localRoot, name)).catch(() => undefined)
        }
        throw error
      }
      await Promise.all([...backups.values()].map((backup) => fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)))

      return {
        harnessId: "cursor",
        pluginRoots: [...desired].map(([name, plugin]) => ({
          pluginInstanceId: plugin.pluginInstanceId,
          root: path.join(localRoot, name),
          dataRoot: plugin.dataRoot,
          external: true as const,
        })),
        diagnostics: [],
      }
    },
  }
}
