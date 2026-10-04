import { checksum } from "@/ui/utils"
import { createByteBoundedCache } from "./byte-bounded-cache"
import type { MarkdownToken } from "./markdown-worker-protocol"

type CodeHighlight = {
  language: string
  generation: number
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

type CodeHighlightEntry = {
  src: string
  value: CodeHighlight
}

function cacheKey(src: string, language: string, theme: string) {
  return `${theme}\u0000${language}\u0000${src.length}\u0000${checksum(src) ?? "0"}`
}

function entryBytes(entry: CodeHighlightEntry) {
  let bytes = entry.src.length
  for (const token of entry.value.stable) bytes += token[0].length + token[1].length
  for (const token of entry.value.unstable) bytes += token[0].length + token[1].length
  return bytes
}

const codeHighlightCacheLimits = { entries: 4096, bytes: 8_000_000 }

const cache = createByteBoundedCache<string, CodeHighlightEntry>(codeHighlightCacheLimits, (_key, entry) => entryBytes(entry))

export function getCachedCodeHighlight(src: string, language: string, theme: string) {
  const key = cacheKey(src, language, theme)
  if (cache.peek(key)?.src !== src) return undefined
  return cache.get(key)?.value
}

function cacheCodeHighlight(src: string, language: string, theme: string, value: CodeHighlight) {
  cache.set(cacheKey(src, language, theme), { src, value })
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
