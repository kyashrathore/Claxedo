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
 * fcntl command that writes the opened vnode's path into a caller buffer.
 * fcntl is variadic, so the koffi declaration below must keep its "...": on
 * arm64 a fixed-arity call would pass the buffer in a register fcntl ignores.
 */
const F_GETPATH = 50

type MacDescriptorPath = {
  getPath: (fd: number) => string | undefined
  // The loaded dylib and its bound function must stay reachable: letting them
  // be collected finalizes the FFI handles getPath still calls.
  keep: unknown[]
}

let macDescriptorPath: Promise<MacDescriptorPath | null> | undefined

/**
 * macOS answers where a descriptor landed through F_GETPATH, a call Node does
 * not bind; koffi — already this package's declared dependency — reaches it.
 * Loaded once and remembered. A host that cannot load it cannot answer, and
 * every read below then refuses, the same doctrine as an unreadable /proc
 * entry.
 */
function loadMacDescriptorPath() {
  macDescriptorPath ??= (async () => {
    try {
      const { load } = await import("koffi")
      const lib = load("libSystem.B.dylib")
      const fcntl = lib.func("int fcntl(int fd, int cmd, ...)")
      const getPath = (fd: number) => {
        try {
          const buffer = Buffer.alloc(4096)
          if (fcntl(fd, F_GETPATH, "void *", buffer) !== 0) return undefined
          const end = buffer.indexOf(0)
          return buffer.toString("utf8", 0, end < 0 ? buffer.length : end) || undefined
        } catch {
          return undefined
        }
      }
      return { getPath, keep: [lib, fcntl] }
    } catch {
      return null
    }
  })()
  return macDescriptorPath
}

/**
 * Whether the descriptor is still inside the workspace, for platforms that
 * publish where a descriptor landed. Linux answers through /proc/self/fd and
 * macOS through F_GETPATH; the reported path is the vnode's real location, so
 * a parent directory replaced between the check above and the open shows up
 * as the outside path the open actually travelled. An unanswered read on
 * either is a missing answer, not a pass. Windows keeps
 * GetFinalPathNameByHandle behind a call still unbound here, so the race stays
 * open there.
 */
async function descriptorInsideWorkspace(directory: string, handle: FileHandle) {
  let opened: string | undefined
  if (process.platform === "linux") {
    opened = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
  } else if (process.platform === "darwin") {
    opened = (await loadMacDescriptorPath())?.getPath(handle.fd)
  } else {
    return true
  }
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
