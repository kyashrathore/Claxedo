import { isRecord, isString } from "@claxedo/helpers/guards"
import { constants, type Stats } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { resolveWorkspacePath } from "../target"

/** A path git may report for a working-tree file: relative, null-free, lexically inside the workspace. */
export function workspaceRelativeFile(input: string): string | undefined {
  if (!input || input.includes("\0")) return undefined
  if (path.isAbsolute(input)) return undefined
  const normalized = path.normalize(input)
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined
  return input
}

/** O_NOFOLLOW on a symlink. Linux and macOS report ELOOP; the BSDs report EMLINK. */
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EMLINK"])

function refusedAsSymlink(err: unknown) {
  return isRecord(err) && isString(err.code) && SYMLINK_OPEN_CODES.has(err.code)
}

/**
 * One inode, so the descriptor is the entry that was classified. A hardlink to
 * it is the same bytes; anything else is a different file. Zero means the
 * platform numbered nothing and has answered nothing.
 */
function openedTheClassifiedEntry(classified: Stats, opened: Stats) {
  return classified.ino !== 0 && classified.dev === opened.dev && classified.ino === opened.ino
}

type WorkingTreeEntry = { link: string } | { handle: FileHandle }

async function linkEntry(file: string): Promise<WorkingTreeEntry | undefined> {
  const link = await fs.readlink(file).catch(() => undefined)
  return link === undefined ? undefined : { link }
}

/**
 * The final component, opened or reported as a link, never followed.
 *
 * With O_NOFOLLOW the open is itself the classification, so no swap fits
 * between the two. Windows binds no such flag, so there the entry is
 * classified first and the descriptor is accepted only while it still carries
 * the inode that was classified: a symlink swapped in under the open is opened
 * but refused unread, and a platform that numbers no inode is refused too.
 */
async function openWithoutFollowing(file: string): Promise<WorkingTreeEntry | undefined> {
  const noFollow = constants.O_NOFOLLOW
  if (noFollow !== undefined) {
    try {
      return { handle: await fs.open(file, constants.O_RDONLY | noFollow) }
    } catch (err) {
      return refusedAsSymlink(err) ? await linkEntry(file) : undefined
    }
  }

  const classified = await fs.lstat(file).catch(() => undefined)
  if (!classified) return undefined
  if (classified.isSymbolicLink()) return await linkEntry(file)

  const handle = await fs.open(file, constants.O_RDONLY).catch(() => undefined)
  if (!handle) return undefined
  const opened = await handle.stat().catch(() => undefined)
  if (opened && openedTheClassifiedEntry(classified, opened)) return { handle }
  await handle.close().catch(() => {})
  return undefined
}

/**
 * Whether the descriptor is still inside the workspace, for platforms that
 * publish where a descriptor landed. Linux does, through /proc/self/fd; an
 * unreadable one there is a missing answer, not a pass. macOS (fcntl
 * F_GETPATH) and Windows (GetFinalPathNameByHandle) keep it behind calls Node
 * does not bind, and on those a parent directory replaced between the check
 * below and the open goes unnoticed — the race this cannot close.
 */
async function descriptorInsideWorkspace(directory: string, handle: FileHandle) {
  if (process.platform !== "linux") return true
  const opened = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
  if (opened === undefined) return false
  return await resolveWorkspacePath(directory, opened, { allowAbsoluteWithinRoot: true }).then(() => true, () => false)
}

/**
 * Working-tree text for one workspace-relative path, or undefined when the path
 * escapes the workspace or cannot be read.
 *
 * A symlink reads as its target path — the bytes git itself stores for that
 * entry — so a link to /etc/shadow yields a path, never the secret behind it.
 * Containment stays `resolveWorkspacePath`'s decision, asked about the parent,
 * whose realpath the open then travels so no validated symlink sits in the
 * path, and asked again about where the descriptor landed.
 */
export async function readWorkingTreeText(input: {
  directory: string
  file: string
}): Promise<string | undefined> {
  const relative = workspaceRelativeFile(input.file)
  if (!relative) return undefined

  let file: string
  try {
    const parent = await resolveWorkspacePath(input.directory, path.dirname(relative), { exactInput: true })
    file = path.join(await fs.realpath(parent), path.basename(relative))
  } catch {
    return undefined
  }

  const entry = await openWithoutFollowing(file)
  if (!entry) return undefined
  if ("link" in entry) return entry.link

  try {
    if (!await descriptorInsideWorkspace(input.directory, entry.handle)) return undefined
    return await entry.handle.readFile("utf-8").catch(() => undefined)
  } finally {
    await entry.handle.close().catch(() => {})
  }
}
