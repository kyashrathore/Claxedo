export function localPreviewUrl(output: string): string | undefined {
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i.exec(output)
  if (!match) return undefined
  const quote = output[match.index - 1]
  if (quote === '"' || quote === "'") return undefined
  const url = match[0].replace(/0\.0\.0\.0/, "127.0.0.1").replace(/[.,)]+$/, "")
  if (!URL.canParse(url) || new URL(url).pathname.startsWith("/api/")) return undefined
  return url
}
