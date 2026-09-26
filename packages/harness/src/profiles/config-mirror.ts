import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { realPathWithinRoot } from "@claxedo/helpers/fs"

export type ConfigMirrorOptions = {
  secretFile: RegExp
  externalSkillRoot?: string
}

export async function existingEntry(pathname: string) {
  try { return await fs.lstat(pathname) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

async function replaceFile(source: string, target: string, stat: Awaited<ReturnType<typeof fs.stat>>): Promise<void> {
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await fs.copyFile(source, staging, constants.COPYFILE_FICLONE)
    await fs.chmod(staging, 0o600)
    await fs.utimes(staging, stat.atime, stat.mtime)
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { force: true })
    throw error
  }
}

async function mirrorDirectory(source: string, target: string, boundary: string, options: ConfigMirrorOptions, visited: Set<string>): Promise<void> {
  const prior = await existingEntry(target)
  if (prior && !prior.isDirectory()) await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  const names = (await fs.readdir(source)).filter((name) => !options.secretFile.test(name))
  for (const name of await fs.readdir(target)) if (!names.includes(name)) await fs.rm(path.join(target, name), { recursive: true, force: true })
  for (const name of names) await mirrorConfigEntry(path.join(source, name), path.join(target, name), boundary, options, visited)
}

export async function mirrorConfigEntry(source: string, target: string, root: string, options: ConfigMirrorOptions,
  visited: Set<string> = new Set()): Promise<void> {
  const { resolved, within } = await realPathWithinRoot(source, root)
  const stat = await fs.stat(source)
  let boundary = root
  if (!within) {
    const skillLink = options.externalSkillRoot !== undefined && stat.isDirectory() &&
      (source === options.externalSkillRoot || path.dirname(source) === options.externalSkillRoot)
    if (!skillLink) throw new Error("config mirror link escapes the person's home")
    try { await fs.access(path.join(resolved, "SKILL.md")) }
    catch (error) { throw new Error("config mirror external skill link has no SKILL.md", { cause: error }) }
    boundary = resolved
  }
  if (visited.has(resolved)) throw new Error("config mirror contains a link cycle")
  const branch = new Set(visited)
  branch.add(resolved)
  if (stat.isDirectory()) {
    await mirrorDirectory(source, target, boundary, options, branch)
    return
  }
  if (!stat.isFile()) throw new Error("config mirror contains a non-file entry")
  const prior = await existingEntry(target)
  if (prior?.isFile() && prior.size === stat.size && Math.floor(prior.mtimeMs) === Math.floor(stat.mtimeMs)) return
  if (prior && !prior.isFile()) await fs.rm(target, { recursive: true, force: true })
  await replaceFile(source, target, stat)
}
