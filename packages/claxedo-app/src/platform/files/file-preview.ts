const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
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

export function imagePreviewUrl(input: {
  path: string
  text?: string
  binary?: { content: string; encoding?: "base64"; mimeType?: string }
}) {
  const extension = input.path.split(".").pop()?.toLowerCase() ?? ""
  const declaredMime = input.binary?.mimeType
  const mime = declaredMime?.toLowerCase().startsWith("image/")
    ? declaredMime
    : IMAGE_MIME_BY_EXTENSION[extension]

  if (input.binary?.encoding === "base64" && mime) return `data:${mime};base64,${input.binary.content}`
  if (extension === "svg" && input.text !== undefined) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(input.text)}`
  }
}
