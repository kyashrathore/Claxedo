import { open, stat } from "node:fs/promises"
import { isMissingFile } from "@claxedo/helpers/fs"
import type { AgentFileContent } from "@claxedo/agent-runtime-contract"

// The transcript refuses tool images above the same 20 MiB; every result here
// is held whole in memory, then JSON-encoded or structured-cloned over IPC.
export const FILE_CONTENT_MAX_BYTES = 20 * 1024 * 1024

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
}

export type FileContentRefusal = "missing" | "not_a_file" | "too_large"

export class FileContentError extends Error {
  readonly refusal: FileContentRefusal

  constructor(refusal: FileContentRefusal, message: string) {
    super(message)
    this.name = "FileContentError"
    this.refusal = refusal
  }
}

export async function readFileContent(file: string): Promise<AgentFileContent> {
  const info = await stat(file).catch((error: unknown) => {
    if (isMissingFile(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) throw new FileContentError("missing", "The file does not exist.")
    throw error
  })
  if (!info.isFile()) throw new FileContentError("not_a_file", "The path is not a file.")
  if (info.size > FILE_CONTENT_MAX_BYTES) {
    throw new FileContentError("too_large", `The file is larger than ${FILE_CONTENT_MAX_BYTES / 1024 / 1024} MiB.`)
  }
  return fileContentOf(file, await readUpTo(file, info.size))
}

function fileContentOf(file: string, bytes: Buffer): AgentFileContent {
  if (!bytes.includes(0)) {
    try {
      return { type: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() }
    } catch {}
  }
  const mimeType = IMAGE_MIME_BY_EXTENSION[file.split(".").pop()?.toLowerCase() ?? ""]
  if (!mimeType) return { type: "binary", content: "" }
  return { type: "binary", content: bytes.toString("base64"), encoding: "base64", mimeType }
}

// Bounded by the size `stat` reported, so a file that grows after the cap
// check cannot push the read past it.
async function readUpTo(file: string, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size)
  const handle = await open(file, "r")
  try {
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}
