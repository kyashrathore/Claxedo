import { checksum } from "@opencode-ai/core/util/encode"
import type { MarkdownToken } from "./markdown-worker-protocol"

/**
 * Module-scope cache for COMPLETED code-block highlights.
 *
 * The worker round trip for highlighting costs ~50ms per session switch
 * (docs/perf/HANDOFF.md), and the old per-component `completedCode` map died
 * with every unmount, so switching back to a session re-paid the worker for
 * code the user had already seen. This cache outlives component instances and
 * is keyed by content, so a remount renders highlighted tokens synchronously.
 *
 * Keying: (theme, language, src length, src checksum), verified against the
 * stored `src` on read — `checksum` is a 32-bit FNV-1a hash, so a collision
 * must degrade to a cache miss, never to rendering the wrong code. Theme is
 * part of the key so a differently-themed highlight can never be served
 * stale; today's only theme ("OpenCode") tokenizes into CSS-variable styles,
 * so light/dark switches restyle cached tokens without invalidation.
 *
 * Bounds: entry- AND byte-capped (the HANDOFF names an uncapped query cache
 * as a known memory hazard — this cache must not repeat that). Eviction is
 * LRU via Map insertion order: reads re-insert, overflow evicts the oldest.
 *
 * Streaming: callers must only cache completed blocks. `highlightCodeThroughCache`
 * enforces that — a still-growing block bypasses both read and write.
 */

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
  entries: 256,
  // UTF-16 code units of cached text (source + token content + token styles),
  // so resident memory is roughly twice this. ~2 MB of highlighted output.
  bytes: 2_000_000,
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
  if (!entry) return
  if (entry.src !== src) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

export function cacheCodeHighlight(src: string, language: string, theme: string, value: CodeHighlight) {
  const bytes = entryBytes(src, value)
  // An entry larger than the whole budget would evict everything and still
  // overflow; skip it instead of thrashing the cache.
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

/**
 * Read-through used by markdown.tsx's `code()`: serve completed blocks from
 * the cache, otherwise run `highlight` and cache the result — but only for
 * completed blocks, and only on success (the caller's fallback tokens for a
 * failed worker must never be pinned as "highlighted").
 */
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

export function codeHighlightCacheStats() {
  return { entries: cache.size, bytes: totalBytes }
}

export function clearCodeHighlightCache() {
  cache.clear()
  totalBytes = 0
}
