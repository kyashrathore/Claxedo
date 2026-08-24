import fs from "node:fs/promises"
import { nodeErrorCode } from "./errors"

const PORTABLE_UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOTSUP", "EBADF", "EISDIR"])

/**
 * Persist a directory entry update when the host filesystem supports it.
 *
 * Windows permits opening a directory but rejects fsync with EPERM. That is a
 * platform capability result, not a write-permission failure: the file itself
 * has already been synced and the rename has completed. Other EPERM failures
 * still propagate on platforms where directory fsync is supported.
 */
export async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } catch (error) {
    const code = nodeErrorCode(error)
    if (!PORTABLE_UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code ?? "") && !(process.platform === "win32" && code === "EPERM")) {
      throw error
    }
  } finally {
    await handle.close()
  }
}
