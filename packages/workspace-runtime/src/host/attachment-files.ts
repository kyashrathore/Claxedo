import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { AttachmentReader } from "@claxedo/session-core"

export const readSessionAttachment: AttachmentReader = async (filePath, maximumBytes) => {
  if (!path.isAbsolute(filePath)) return undefined
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
