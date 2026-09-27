import { checksum } from "@/ui/utils"
import type { MarkdownToken } from "./markdown-worker-protocol"

export type CodeHighlight = {
  language: string
  generation: number
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

type CodeHighlightEntry = {
  src: string
  value: CodeHighlight
  bytes: number
}

export const codeHighlightCacheLimits = {
  entries: 4096,
  bytes: 8_000_000,
}

const cache = new Map<string, CodeHighlightEntry>()
let totalBytes = 0

function cacheKey(src: string, language: string, theme: string) {
  return `${theme}\u0000${language}\u0000${src.length}\u0000${checksum(src) ?? "0"}`
}

function entryBytes(src: string, value: CodeHighlight) {
  let bytes = src.length
  for (const token of value.stable) bytes += token[0].length + token[1].length
  for (const token of value.unstable) bytes += token[0].length + token[1].length
  return bytes
}

export function getCachedCodeHighlight(src: string, language: string, theme: string) {
  const key = cacheKey(src, language, theme)
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.src !== src) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

export function cacheCodeHighlight(src: string, language: string, theme: string, value: CodeHighlight) {
  const bytes = entryBytes(src, value)
  if (bytes > codeHighlightCacheLimits.bytes) return
  const key = cacheKey(src, language, theme)
  const existing = cache.get(key)
  if (existing) {
    totalBytes -= existing.bytes
    cache.delete(key)
  }
  cache.set(key, { src, value, bytes })
  totalBytes += bytes
  while (cache.size > codeHighlightCacheLimits.entries || totalBytes > codeHighlightCacheLimits.bytes) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    totalBytes -= oldest[1].bytes
    cache.delete(oldest[0])
  }
}

export async function highlightCodeThroughCache(
  src: string,
  language: string,
  theme: string,
  complete: boolean,
  highlight: () => Promise<CodeHighlight>,
): Promise<CodeHighlight> {
  if (complete) {
    const cached = getCachedCodeHighlight(src, language, theme)
    if (cached) return cached
  }
  const result = await highlight()
  if (complete) cacheCodeHighlight(src, language, theme, result)
  return result
}
