import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { McpServerConfig, SettingSource } from "@cursor/sdk"
import { lstatIfExists, realPathWithinRoot } from "@claxedo/helpers/fs"
import { asRecord } from "@claxedo/helpers/guards"
import type { McpServerSpec, PluginProjection, SkillRoot, TurnActor } from "../../contract"
import type { RuntimePlacement } from "../../registry/credentials"
import { mirrorConfigTree, type ConfigMirrorOptions } from "../config-mirror"

const OWNER = "claxedo-agent-plugins"
const PREFIX = "claxedo--"
const MARKER = ".claxedo-agent-plugin.json"
const MIRRORED = ["mcp.json", "settings.json", "sandbox.json", "hooks.json", "rules", "skills", "skills-cursor", "agents"] as const
const SECRET_FILE = /^(?:mcp-auth\.json|auth\.json)$|(?:^|[-_.])(?:credential|credentials|oauth|auth|secret|token|password|keychain)(?:[-_.]|$)/i
const mirror: ConfigMirrorOptions = { secretFile: SECRET_FILE, externalSkills: true }

export type CursorLoginOptions = { placement: RuntimePlacement; machineOwnerUserId: string; canUseOwnLogin: boolean }

export type CursorPluginOptions = { settingSources?: SettingSource[] }

export type CursorHome = { home: string; local: CursorPluginOptions }

function cursorMcp(server: McpServerSpec): McpServerConfig {
  if (server.kind === "stdio") return { type: "stdio", command: server.command, args: [...server.args ?? []], env: { ...server.env }, ...(server.cwd ? { cwd: server.cwd } : {}) }
  return { type: server.kind, url: server.url, headers: { ...server.headers } }
}

export function projectCursorMcpServers(servers: readonly McpServerSpec[]): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    result[server.name] = cursorMcp(server)
  }
  return result
}

export function cursorHomeKey(owner: TurnActor, login: Pick<CursorLoginOptions, "machineOwnerUserId">, binding: string,
  projection: Pick<PluginProjection, "pluginRoots">): string {
  const selection = [...new Set(projection.pluginRoots.map((plugin) => plugin.pluginInstanceId))].sort()
  const ownerId = owner.kind === "person" ? owner.userId : login.machineOwnerUserId
  return createHash("sha256").update(JSON.stringify([ownerId, binding, selection])).digest("hex").slice(0, 16)
}

function managedPluginName(plugin: SkillRoot): string {
  const readable = path.basename(plugin.root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "plugin"
  return `${PREFIX}${readable}--${createHash("sha256").update(plugin.pluginInstanceId).digest("hex").slice(0, 12)}`
}

async function readPluginMarker(folder: string, name: string): Promise<Record<string, unknown> | undefined> {
  let content: string
  try { content = await fs.readFile(path.join(folder, name, MARKER), "utf8") }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined
    throw error
  }
  const marker = asRecord(JSON.parse(content))
  return marker?.owner === OWNER && marker.directory === name ? marker : undefined
}

async function managedEntries(folder: string): Promise<Set<string>> {
  const managed = new Set<string>()
  for (const name of await fs.readdir(folder)) {
    if (name.startsWith(PREFIX) && await readPluginMarker(folder, name)) managed.add(name)
  }
  return managed
}

async function stagePlugin(folder: string, name: string, plugin: SkillRoot, transaction: string): Promise<string> {
  const staging = path.join(folder, `.claxedo-staging-${transaction}-${name.slice(PREFIX.length)}`)
  const pluginRoot = await fs.realpath(plugin.root)
  const filter = async (pathname: string) => {
    if (!(await realPathWithinRoot(pathname, pluginRoot)).within) throw new Error(`Cursor plugin link escapes its root: ${pathname}`)
    return true
  }
  try {
    await fs.cp(plugin.root, staging, { recursive: true, dereference: true, force: false, errorOnExist: true, filter })
    await fs.writeFile(path.join(staging, MARKER), `${JSON.stringify({ owner: OWNER, directory: name, pluginInstanceId: plugin.pluginInstanceId }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  return staging
}

async function replaceManaged(folder: string, desired: Map<string, SkillRoot>, existing: Set<string>): Promise<void> {
  const transaction = randomUUID()
  const staged = new Map<string, string>()
  const backups = new Map<string, string>()
  const activated = new Set<string>()
  try {
    for (const [name, plugin] of desired) staged.set(name, await stagePlugin(folder, name, plugin, transaction))
    for (const name of existing) {
      const backup = path.join(folder, `.claxedo-backup-${transaction}-${name.slice(PREFIX.length)}`)
      await fs.rename(path.join(folder, name), backup)
      backups.set(name, backup)
    }
    for (const [name, staging] of staged) {
      await fs.rename(staging, path.join(folder, name))
      activated.add(name)
    }
  } catch (error) {
    for (const staging of staged.values()) await fs.rm(staging, { recursive: true, force: true })
    for (const name of activated) await fs.rm(path.join(folder, name), { recursive: true, force: true })
    for (const [name, backup] of backups) await fs.rename(backup, path.join(folder, name))
    throw error
  }
  for (const backup of backups.values()) await fs.rm(backup, { recursive: true, force: true })
}

export async function projectCursorPlugins(projection: Pick<PluginProjection, "pluginRoots">, folder: string): Promise<boolean> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const existing = await managedEntries(folder)
  const desired = new Map<string, SkillRoot>()
  for (const plugin of projection.pluginRoots) {
    const name = managedPluginName(plugin)
    if (desired.has(name)) throw new Error(`Duplicate Cursor plugin ${plugin.pluginInstanceId}`)
    if (!existing.has(name) && await lstatIfExists(path.join(folder, name))) {
      throw new Error(`Cursor plugin destination ${path.join(folder, name)} is not owned by Claxedo`)
    }
    desired.set(name, plugin)
  }
  if (desired.size || existing.size) await replaceManaged(folder, desired, existing)
  return desired.size > 0
}

async function mirrorPersonalPlugins(personalFolder: string, folder: string, personalRoot: string): Promise<void> {
  const names = (await lstatIfExists(personalFolder))?.isDirectory()
    ? (await fs.readdir(personalFolder)).filter((name) => !name.startsWith(".") && !name.startsWith(PREFIX)) : []
  for (const name of await fs.readdir(folder)) {
    if (name.startsWith(".") || name.startsWith(PREFIX) || names.includes(name)) continue
    await fs.rm(path.join(folder, name), { recursive: true, force: true })
  }
  for (const name of names) {
    await mirrorConfigTree(path.join(personalFolder, name), path.join(folder, name), personalRoot, mirror, path.join("plugins", "local", name))
  }
}

async function mirrorPersonalConfig(personal: string | undefined, cursorDir: string): Promise<void> {
  const root = personal && (await lstatIfExists(personal))?.isDirectory() ? await fs.realpath(personal) : undefined
  for (const name of MIRRORED) {
    const target = path.join(cursorDir, name)
    const source = root ? path.join(root, name) : undefined
    if (!source || !(await lstatIfExists(source))) {
      await fs.rm(target, { recursive: true, force: true })
      continue
    }
    await mirrorConfigTree(source, target, root!, mirror, name)
  }
  const folder = path.join(cursorDir, "plugins", "local")
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  if (root) await mirrorPersonalPlugins(path.join(root, "plugins", "local"), folder, root)
}

export async function composeCursorHome(input: { root: string; key: string; personalCursorDir?: string;
  projection: Pick<PluginProjection, "pluginRoots"> }): Promise<CursorHome> {
  const home = path.join(input.root, input.key)
  const cursorDir = path.join(home, ".cursor")
  await fs.mkdir(cursorDir, { recursive: true, mode: 0o700 })
  await mirrorPersonalConfig(input.personalCursorDir, cursorDir)
  const delivered = await projectCursorPlugins(input.projection, path.join(cursorDir, "plugins", "local"))
  return { home, local: { settingSources: delivered ? ["user", "plugins"] : ["user"] } }
}
