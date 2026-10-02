import { constants } from "node:fs"
import path from "node:path"
import type { AttachmentReader } from "@claxedo/session-core"
import { openWithoutFollowing } from "../workspace-files/open-without-following"

export const readSessionAttachment: AttachmentReader = async (filePath, maximumBytes) => {
  if (!path.isAbsolute(filePath)) return undefined
  const entry = await openWithoutFollowing(filePath, constants.O_NONBLOCK)
  if (!entry || "link" in entry) return undefined
  const file = entry.handle
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0) return undefined
    if (stat.size > maximumBytes) return "too-large"
    // Bound allocation even if another process grows the file during this read.
    const bytes = new Uint8Array(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) return undefined
      offset += read.bytesRead
    }
    return bytes
  } finally { await file.close() }
}
