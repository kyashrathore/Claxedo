import fs from "node:fs/promises"
import { nodeErrorCode } from "./errors"

/**
 * Flush a directory's metadata after an atomic rename/link/unlink, where the
 * platform can.
 *
 * The documents subsystem writes through the temp-file → fsync → rename
 * pattern, and the rename is only durable once the PARENT DIRECTORY's entry
 * table reaches disk — that is what this fsync is for. Every writer here used
 * to carry its own copy of this function, each with a slightly different idea
 * of which failures were tolerable; this is the one owner.
 *
 * The tolerated codes are the "this platform cannot fsync a directory" class,
 * not "the fsync failed": EINVAL/ENOTSUP (filesystems that reject directory
 * fsync), EBADF/EISDIR (runtimes that refuse the handle shape), and EPERM —
 * which is what Windows throws for every directory fsync, because
 * FlushFileBuffers needs write access and a directory handle never has it.
 * On those platforms directory durability is the filesystem's job and there
 * is nothing the caller could do differently. A real I/O failure (EIO) still
 * throws, so the callers that roll back on a failed flush keep meaning it.
 */
export async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle.close()
  }
}

function directorySyncUnsupported(error: unknown) {
  return ["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(nodeErrorCode(error) ?? "")
}
