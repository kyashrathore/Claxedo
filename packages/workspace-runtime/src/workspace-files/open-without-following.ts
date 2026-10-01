import { isRecord, isString } from "@claxedo/helpers/guards"
import { constants, type Stats } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"

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

export type UnfollowedEntry = { link: string } | { handle: FileHandle }

async function linkEntry(file: string): Promise<UnfollowedEntry | undefined> {
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
export async function openWithoutFollowing(file: string, flags = 0): Promise<UnfollowedEntry | undefined> {
  const noFollow = constants.O_NOFOLLOW
  if (noFollow !== undefined) {
    try {
      return { handle: await fs.open(file, constants.O_RDONLY | noFollow | flags) }
    } catch (err) {
      return refusedAsSymlink(err) ? await linkEntry(file) : undefined
    }
  }

  const classified = await fs.lstat(file).catch(() => undefined)
  if (!classified) return undefined
  if (classified.isSymbolicLink()) return await linkEntry(file)

  const handle = await fs.open(file, constants.O_RDONLY | flags).catch(() => undefined)
  if (!handle) return undefined
  const opened = await handle.stat().catch(() => undefined)
  if (opened && openedTheClassifiedEntry(classified, opened)) return { handle }
  await handle.close().catch(() => {})
  return undefined
}
