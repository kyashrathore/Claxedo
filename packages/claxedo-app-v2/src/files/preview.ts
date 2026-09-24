import type { FileContent } from "@/server"

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

const MEDIA_EXTENSIONS = new Set([
  ...Object.keys(IMAGE_MIME_BY_EXTENSION),
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "mp4",
  "webm",
  "mov",
])

export function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(path))
}

export function imagePreviewUrl(path: string, content: FileContent): string | undefined {
  const extension = extensionOf(path)
  const declared = content.mimeType
  const mime = declared?.toLowerCase().startsWith("image/") ? declared : IMAGE_MIME_BY_EXTENSION[extension]
  if (content.encoding === "base64" && mime) return `data:${mime};base64,${content.content}`
  if (extension === "svg" && content.type === "text") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.content)}`
  }
  return undefined
}
