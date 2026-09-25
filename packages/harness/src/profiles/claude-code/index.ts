import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk"
import type { PluginProjection } from "../../contract"

const SETTINGS = ["settings.json", "settings.local.json", "cowork_settings.json"] as const
const MIRRORED = ["CLAUDE.md", "memory", "agents", "commands", "skills", "plugins"] as const
const CREDENTIAL_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"]
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_)|(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)(_|$)/

async function existing(pathname: string) {
  try { return await fs.lstat(pathname) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export function claudePlugins(projection: PluginProjection): SdkPluginConfig[] {
  return [...new Set(projection.pluginRoots.map((root) => root.root))].map((pluginPath) => ({ type: "local", path: pluginPath }))
}

export function scrubClaudeSettings(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings must be an object")
  const values = Object.fromEntries(Object.entries(parsed).filter(([key]) => !CREDENTIAL_KEYS.includes(key)))
  if (values.env && (typeof values.env !== "object" || Array.isArray(values.env))) throw new Error("Claude settings env must be an object")
  if (!values.env) return values
  return { ...values, env: Object.fromEntries(Object.entries(values.env).filter(([name]) => !CREDENTIAL_ENV.test(name))) }
}

async function copyReadOnly(source: string, target: string, home: string, visited = new Set<string>(), externalSkill = false): Promise<void> {
  const resolved = await fs.realpath(source)
  const stat = await fs.stat(source)
  let boundary = home
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    if (!externalSkill || !stat.isDirectory()) throw new Error("Claude config mirror link escapes the person's home")
    try { await fs.access(path.join(resolved, "SKILL.md")) }
    catch (error) { throw new Error("Claude external skill link has no SKILL.md", { cause: error }) }
    boundary = resolved
  }
  if (visited.has(resolved)) throw new Error("Claude config mirror contains a link cycle")
  const branch = new Set(visited)
  branch.add(resolved)
  if (stat.isDirectory()) {
    const prior = await existing(target)
    if (prior && !prior.isDirectory()) await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    const names = await fs.readdir(source)
    for (const name of await fs.readdir(target)) if (!names.includes(name)) await fs.rm(path.join(target, name), { recursive: true, force: true })
    for (const name of names) await copyReadOnly(path.join(source, name), path.join(target, name), boundary,
      branch, externalSkill && source === path.join(home, "skills"))
    return
  }
  if (!stat.isFile()) throw new Error("Claude config mirror contains a non-file entry")
  const prior = await existing(target)
  if (prior?.isFile() && prior.size === stat.size && Math.floor(prior.mtimeMs) === Math.floor(stat.mtimeMs)) return
  if (prior) await fs.rm(target, { recursive: true, force: true })
  await fs.copyFile(source, target, constants.COPYFILE_FICLONE)
  await fs.chmod(target, 0o600)
  await fs.utimes(target, stat.atime, stat.mtime)
}

export async function composeClaudeConfigHome(root: string, source: string): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const home = await fs.realpath(source).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return path.resolve(source)
    throw error
  })
  for (const name of MIRRORED) {
    const from = path.join(home, name)
    const to = path.join(root, name)
    if (!(await existing(from))) { await fs.rm(to, { recursive: true, force: true }); continue }
    try { await copyReadOnly(from, to, home, undefined, name === "skills") }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
  }
  for (const name of SETTINGS) {
    const from = path.join(source, name)
    const to = path.join(root, name)
    await fs.rm(to, { force: true })
    let content: string
    try { content = await fs.readFile(from, "utf8") }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    await fs.writeFile(to, JSON.stringify(scrubClaudeSettings(content)), { mode: 0o600 })
  }
  return root
}
