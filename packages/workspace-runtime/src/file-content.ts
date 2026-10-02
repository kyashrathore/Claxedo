import { readFile } from "node:fs/promises"
import type { AgentFileContent } from "@claxedo/agent-runtime-contract"

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

export async function readFileContent(file: string): Promise<AgentFileContent> {
  const bytes = await readFile(file)
  if (!bytes.includes(0)) {
    try {
      return { type: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() }
    } catch {
      return binaryContent(file, bytes)
    }
  }
  return binaryContent(file, bytes)
}

function binaryContent(file: string, bytes: Buffer): AgentFileContent {
  const extension = file.split(".").pop()?.toLowerCase() ?? ""
  return { type: "binary", content: bytes.toString("base64"), encoding: "base64", mimeType: IMAGE_MIME_BY_EXTENSION[extension] }
}
