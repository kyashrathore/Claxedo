import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { isMissingFile, lstatIfExists, realPathWithinRoot } from "@claxedo/helpers/fs"

export type ConfigMirrorOptions = {
  secretFile: RegExp
  externalSkills?: boolean
  keep?: (relative: string) => boolean
}

const STAGING_NAME = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

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
    if (names.includes(name) || STAGING_NAME.test(name) || options.keep?.(path.join(relative, name))) continue
    await fs.rm(path.join(target, name), { recursive: true, force: true })
  }
}

export async function mirrorConfigTree(source: string, target: string, root: string, options: ConfigMirrorOptions,
  relative = "", ancestors = new Set<string>()): Promise<void> {
  const { resolved, within } = await realPathWithinRoot(source, root)
  const stat = await fs.stat(source)
  let boundary = root
  if (!within) {
    const skillLink = options.externalSkills === true && stat.isDirectory() && path.dirname(relative) === "skills"
    if (!skillLink) throw new Error(`config mirror link escapes its root: ${source}`)
    try { await fs.access(path.join(resolved, "SKILL.md")) }
    catch (error) { throw new Error(`config mirror external skill link has no SKILL.md: ${source}`, { cause: error }) }
    boundary = resolved
  }
  if (ancestors.has(resolved)) throw new Error(`config mirror contains a link cycle: ${source}`)
  const visited = new Set(ancestors)
  visited.add(resolved)
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error(`config mirror contains a non-file entry: ${source}`)
    await mirrorFile(source, target, stat)
    return
  }
  const names = (await fs.readdir(source)).filter((name) => !options.secretFile.test(name) && !options.keep?.(path.join(relative, name)))
  await pruneMirrorDirectory(target, relative, names, options)
  for (const name of names) {
    await mirrorConfigTree(path.join(source, name), path.join(target, name), boundary, options, path.join(relative, name), visited)
  }
}

export async function mirrorConfigEntries(source: string | undefined, target: string, names: readonly string[], options: ConfigMirrorOptions & {
  initialize?: readonly string[]
  directories?: readonly string[]
  allowDisappeared?: boolean
  allowMissingRoot?: boolean
}): Promise<string | undefined> {
  const root = source === undefined ? undefined : await fs.realpath(source).catch((error: unknown) => {
    if (options.allowMissingRoot && isMissingFile(error)) return path.resolve(source)
    throw error
  })
  for (const name of names) {
    const to = path.join(target, name)
    const initialize = options.initialize?.includes(name)
    if (initialize && await lstatIfExists(to)) continue
    const from = root && path.join(root, name)
    if (!from || !(await lstatIfExists(from))) {
      if (options.directories?.includes(name)) await pruneMirrorDirectory(to, name, [], options)
      else if (!initialize) await fs.rm(to, { recursive: true, force: true })
      continue
    }
    try { await mirrorConfigTree(from, to, root, options, name) }
    catch (error) {
      if (!options.allowDisappeared || !isMissingFile(error)) throw error
    }
  }
  return root
}
