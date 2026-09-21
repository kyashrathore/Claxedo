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

type DescriptorPath = {
  getPath: (fd: number) => string | undefined
  // The loaded libraries and their bound functions must stay reachable:
  // letting them be collected finalizes the FFI handles getPath still calls.
  keep: unknown[]
}

let macDescriptorPath: Promise<DescriptorPath | null> | undefined

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

const INVALID_HANDLE_VALUE = -1
/** FILE_NAME_NORMALIZED | VOLUME_NAME_DOS: the drive-letter spelling, with 8.3 names expanded. */
const FINAL_PATH_FLAGS = 0

/**
 * GetFinalPathNameByHandleW spells its answer in the NT namespace, which the
 * containment check does not read: `\\?\C:\dir` is the DOS path `C:\dir`, and
 * `\\?\UNC\host\share\dir` is `\\host\share\dir`.
 */
export function dosPathFromFinalPath(finalPath: string): string {
  if (finalPath.startsWith("\\\\?\\UNC\\")) return `\\\\${finalPath.slice("\\\\?\\UNC\\".length)}`
  if (finalPath.startsWith("\\\\?\\")) return finalPath.slice("\\\\?\\".length)
  return finalPath
}

let windowsDescriptorPath: Promise<DescriptorPath | null> | undefined

/**
 * Windows answers where a handle landed through GetFinalPathNameByHandleW,
 * which wants the OS handle behind the fd Node hands out. That fd indexes the
 * C runtime libuv was linked with, and the running executable exports libuv,
 * so uv_get_osfhandle is bound from the program itself (koffi's null library).
 * ucrtbase.dll's _get_osfhandle is not a substitute: a runtime that links the
 * CRT statically keeps its own table, and an fd that table does not hold
 * trips the invalid-parameter handler, which ends the process rather than
 * returning. Loaded once and remembered; a host that cannot bind either
 * symbol answers nothing, and every read below then refuses.
 */
function loadWindowsDescriptorPath() {
  windowsDescriptorPath ??= (async () => {
    try {
      const { load } = await import("koffi")
      const program = load(null)
      const kernel32 = load("kernel32.dll")
      const getOsHandle = program.func("intptr_t uv_get_osfhandle(int fd)")
      const getFinalPathName = kernel32.func(
        "uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t file, void *path, uint32_t capacity, uint32_t flags)",
      )
      const getPath = (fd: number) => {
        try {
          const handle = getOsHandle(fd)
          if (handle === 0 || handle === INVALID_HANDLE_VALUE) return undefined
          // A result no smaller than the capacity is the size the buffer needs,
          // terminator included; a result under it is the length written.
          let capacity = 1024
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const buffer = Buffer.alloc(capacity * 2)
            const length = getFinalPathName(handle, buffer, capacity, FINAL_PATH_FLAGS)
            if (length === 0) return undefined
            if (length < capacity) return dosPathFromFinalPath(buffer.toString("utf16le", 0, length * 2))
            capacity = length
          }
          return undefined
        } catch {
          return undefined
        }
      }
      return { getPath, keep: [program, kernel32, getOsHandle, getFinalPathName] }
    } catch {
      return null
    }
  })()
  return windowsDescriptorPath
}

/**
 * Whether the descriptor is still inside the workspace. Linux answers through
 * /proc/self/fd, macOS through F_GETPATH and Windows through
 * GetFinalPathNameByHandleW; the reported path is where the open actually
 * travelled, so a parent directory replaced between the check above and the
 * open shows up as the outside path. No answer — an unreadable /proc entry, an
 * FFI that did not bind, a platform with no arm — is a refusal, not a pass.
 */
async function descriptorInsideWorkspace(directory: string, handle: FileHandle) {
  let opened: string | undefined
  if (process.platform === "linux") {
    opened = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
  } else if (process.platform === "darwin") {
    opened = (await loadMacDescriptorPath())?.getPath(handle.fd)
  } else if (process.platform === "win32") {
    opened = (await loadWindowsDescriptorPath())?.getPath(handle.fd)
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
