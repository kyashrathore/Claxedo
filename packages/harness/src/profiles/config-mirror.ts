import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { lstatIfExists, realPathWithinRoot } from "@claxedo/helpers/fs"

export type ConfigMirrorOptions = {
  secretFile: RegExp
  externalSkills?: boolean
  keep?: (relative: string) => boolean
}

type Walk = { boundary: string; relative: string; visited: Set<string> }

export async function replaceAtomically(target: string, stage: (temporary: string) => Promise<void>): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await stage(temporary)
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function mirrorFile(source: string, target: string, stat: Stats): Promise<void> {
  const prior = await lstatIfExists(target)
  const mode = stat.mode & 0o111 ? 0o700 : 0o600
  if (prior?.isFile() && prior.size === stat.size && Math.floor(prior.mtimeMs) === Math.floor(stat.mtimeMs) && (prior.mode & 0o7777) === mode) return
  if (prior && !prior.isFile()) await fs.rm(target, { recursive: true, force: true })
  await replaceAtomically(target, async (temporary) => {
    await fs.copyFile(source, temporary, constants.COPYFILE_FICLONE)
    await fs.chmod(temporary, mode)
    await fs.utimes(temporary, stat.atime, stat.mtime)
  })
}

export async function pruneMirrorDirectory(target: string, relative: string, names: readonly string[], options: ConfigMirrorOptions): Promise<void> {
  const prior = await lstatIfExists(target)
  if (prior && !prior.isDirectory()) await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  for (const name of await fs.readdir(target)) {
    if (names.includes(name) || name.endsWith(".tmp") || options.keep?.(path.join(relative, name))) continue
    await fs.rm(path.join(target, name), { recursive: true, force: true })
  }
}

async function mirrorEntry(source: string, target: string, options: ConfigMirrorOptions, walk: Walk): Promise<void> {
  const { resolved, within } = await realPathWithinRoot(source, walk.boundary)
  const stat = await fs.stat(source)
  let boundary = walk.boundary
  if (!within) {
    const skillLink = options.externalSkills === true && stat.isDirectory() && path.dirname(walk.relative) === "skills"
    if (!skillLink) throw new Error(`config mirror link escapes its root: ${source}`)
    try { await fs.access(path.join(resolved, "SKILL.md")) }
    catch (error) { throw new Error(`config mirror external skill link has no SKILL.md: ${source}`, { cause: error }) }
    boundary = resolved
  }
  if (walk.visited.has(resolved)) throw new Error(`config mirror contains a link cycle: ${source}`)
  const visited = new Set(walk.visited)
  visited.add(resolved)
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error(`config mirror contains a non-file entry: ${source}`)
    await mirrorFile(source, target, stat)
    return
  }
  const names = (await fs.readdir(source)).filter((name) => !options.secretFile.test(name) && !options.keep?.(path.join(walk.relative, name)))
  await pruneMirrorDirectory(target, walk.relative, names, options)
  for (const name of names) {
    await mirrorEntry(path.join(source, name), path.join(target, name), options, { boundary, relative: path.join(walk.relative, name), visited })
  }
}

export function mirrorConfigTree(source: string, target: string, root: string, options: ConfigMirrorOptions, relative = ""): Promise<void> {
  return mirrorEntry(source, target, options, { boundary: root, relative, visited: new Set() })
}
