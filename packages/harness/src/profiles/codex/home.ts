import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { ProviderBinding } from "@claxedo/agent-runtime-contract"
import { lstatIfExists, realPathWithinRoot } from "@claxedo/helpers/fs"
import type { PluginProjection, TurnActor } from "../../contract"

export const CLAXEDO_MARKETPLACE = "claxedo-agent-plugins"
const MIRRORED = ["AGENTS.md", "instructions.md", "hooks.json", "skills", "prompts", "rules", "plugins"] as const
const SECRET_FILE = /^(?:auth\.json|\.env)$|(?:^|[-_.])(?:credential|credentials|oauth|secret|token|password|keychain)(?:[-_.]|$)/i
const CODEX_WRITTEN: readonly string[] = [path.join("skills", ".system"), path.join("plugins", "cache", CLAXEDO_MARKETPLACE)]

export function codexHomeKey(owner: TurnActor, selected: ProviderBinding | undefined, projection: PluginProjection): string {
  const ownerKey = owner.kind === "machine-owner" ? "machine-owner" : `person:${owner.userId}`
  const credentialKey = selected ? `broker:${selected.baseUrl}:${selected.authMode}` : "own-login"
  const plugins = [...new Set(projection.pluginRoots.map((root) => root.pluginInstanceId))].sort()
  return `codex-${createHash("sha256").update(JSON.stringify([ownerKey, credentialKey, plugins])).digest("hex").slice(0, 16)}`
}

async function replaceAtomically(target: string, stage: (temporary: string) => Promise<void>): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await stage(temporary)
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function copyFileAtomically(source: string, target: string, stat: { size: number; mtimeMs: number; atime: Date; mtime: Date }): Promise<void> {
  const prior = await lstatIfExists(target)
  if (prior?.isFile() && prior.size === stat.size && Math.floor(prior.mtimeMs) === Math.floor(stat.mtimeMs)) return
  if (prior && !prior.isFile()) await fs.rm(target, { recursive: true, force: true })
  await replaceAtomically(target, async (temporary) => {
    await fs.copyFile(source, temporary, constants.COPYFILE_FICLONE)
    await fs.chmod(temporary, 0o600)
    await fs.utimes(temporary, stat.atime, stat.mtime)
  })
}

async function pruneDirectory(target: string, relative: string, keep: readonly string[]): Promise<void> {
  const prior = await lstatIfExists(target)
  if (prior && !prior.isDirectory()) await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  for (const name of await fs.readdir(target)) {
    if (!keep.includes(name) && !CODEX_WRITTEN.includes(path.join(relative, name)) && !name.endsWith(".tmp")) await fs.rm(path.join(target, name), { recursive: true, force: true })
  }
}

type CopyOptions = { boundary: string; relative: string; visited: Set<string>; externalSkill: boolean }

async function copyEntry(source: string, target: string, options: CopyOptions): Promise<void> {
  const { resolved, within } = await realPathWithinRoot(source, options.boundary)
  const stat = await fs.stat(source)
  let boundary = options.boundary
  if (!within) {
    if (!options.externalSkill || !stat.isDirectory()) throw new Error(`Codex home mirror link escapes its root: ${source}`)
    try { await fs.access(path.join(resolved, "SKILL.md")) }
    catch (error) { throw new Error(`Codex external skill link has no SKILL.md: ${source}`, { cause: error }) }
    boundary = resolved
  }
  if (options.visited.has(resolved)) throw new Error(`Codex home mirror contains a link cycle: ${source}`)
  const visited = new Set(options.visited)
  visited.add(resolved)
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error(`Codex home mirror contains a non-file entry: ${source}`)
    await copyFileAtomically(source, target, stat)
    return
  }
  const names = (await fs.readdir(source)).filter((name) => !SECRET_FILE.test(name) && !CODEX_WRITTEN.includes(path.join(options.relative, name)))
  await pruneDirectory(target, options.relative, names)
  for (const name of names) {
    await copyEntry(path.join(source, name), path.join(target, name), { boundary, relative: path.join(options.relative, name), visited,
      externalSkill: options.externalSkill && options.relative === "skills" })
  }
}

export async function copyTreeAtomically(source: string, target: string, root: string, relative = ""): Promise<void> {
  await copyEntry(source, target, { boundary: root, relative, visited: new Set(), externalSkill: relative === "skills" })
}

async function linkOwnerAuth(ownerHome: string, home: string): Promise<void> {
  const target = path.join(home, "auth.json")
  const auth = path.join(ownerHome, "auth.json")
  if (!(await lstatIfExists(auth))) { await fs.rm(target, { force: true }); return }
  const current = await lstatIfExists(target)
  if (current?.isSymbolicLink() && await fs.readlink(target) === auth) return
  await replaceAtomically(target, (temporary) => fs.symlink(auth, temporary))
}

export async function mirrorOwnerCodexHome(source: string, home: string): Promise<void> {
  const ownerHome = await fs.realpath(source).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return path.resolve(source)
    throw error
  })
  for (const name of MIRRORED) {
    const from = path.join(ownerHome, name)
    const to = path.join(home, name)
    if (await lstatIfExists(from)) await copyTreeAtomically(from, to, ownerHome, name)
    else if (name === "plugins" || name === "skills") await pruneDirectory(to, name, [])
    else await fs.rm(to, { recursive: true, force: true })
  }
  await linkOwnerAuth(ownerHome, home)
}
