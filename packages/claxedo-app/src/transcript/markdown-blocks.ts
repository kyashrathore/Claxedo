import { checksum, markdownEnhances, transcriptMarkdownExtensions } from "@/ui/utils"
import { Marked } from "marked"
import { bundledLanguages } from "shiki"
import { codeThemeName } from "./code-theme-name"
import type { Block, Projection } from "./markdown-stream"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown, type MarkdownCacheEntry } from "./markdown-cache"
import { getCachedCodeHighlight } from "./markdown-code-cache"
import { rendererClock, traceRenderer } from "./markdown-trace"

export type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code">; final: boolean })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

export type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

const syncParser = new Marked(...transcriptMarkdownExtensions)

export function blockHash(raw: string, final: boolean) {
  const hash = checksum(raw) ?? ""
  return final ? hash : `${hash}:first-paint`
}

function syncRichHtml(src: string): { html: string; final: boolean } {
  try {
    const parsed = syncParser.parse(src, { async: false })
    if (typeof parsed !== "string") return { html: fallback(src), final: false }
    return { html: sanitizeMarkdown(parsed), final: !markdownEnhances(parsed) }
  } catch {
    return { html: fallback(src), final: false }
  }
}

export function syncBlock(owner: string, cacheKey: string | undefined, index: number, block: Block): RenderedBlock {
  const key = markdownBlockKey(owner, cacheKey, index, block.mode)
  if (block.mode === "code") {
    return {
      key,
      mode: "code",
      raw: block.raw,
      hash: blockHash(block.raw, true),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  }
  const { html, final } = syncRichHtml(block.src)
  return { key, mode: block.mode, raw: block.raw, hash: blockHash(block.raw, final), html, final }
}

export function codeLanguageName(language: string | undefined) {
  return language && language in bundledLanguages ? language : "text"
}

export function entryBase(text: string, cacheKey: string | undefined) {
  return cacheKey ?? checksum(text)
}

export function blockEntry(base: string, index: number, mode: Block["mode"]) {
  return `${base}:${index}:${mode}`
}

function cachedRenderResult(
  text: string,
  key: string | undefined,
  projection: Projection,
  owner: string,
): RenderResult | undefined {
  if (!text) return { text, blocks: [] }
  const base = entryBase(text, key)
  if (!base) return undefined
  const blocks = projection.blocks.flatMap((block, index): RenderedBlock[] => {
    if (block.mode === "code") {
      if (!block.complete) return []
      const cached = getCachedCodeHighlight(block.src, codeLanguageName(block.language), codeThemeName)
      if (!cached) return []
      return [
        {
          key: markdownBlockKey(owner, key, index, block.mode),
          mode: block.mode,
          raw: block.raw,
          hash: blockHash(block.raw, true),
          complete: true,
          ...cached,
        },
      ]
    }
    const cached = getCachedMarkdown(blockEntry(base, index, block.mode))
    if (cached?.raw !== block.raw) return []
    return [{ key: markdownBlockKey(owner, key, index, block.mode), mode: block.mode, ...cached, final: true }]
  })
  if (blocks.length !== projection.blocks.length) return undefined
  return { text, blocks }
}

export function syncRenderResult(text: string, projection: Projection, owner: string, cacheKey: string | undefined): RenderResult {
  return {
    text,
    blocks: projection.blocks.map((block, index) => syncBlock(owner, cacheKey, index, block)),
  }
}

function finalFirstPaint(initial: RenderResult | undefined, text: string, index: number, raw: string) {
  const block = initial?.text === text ? initial.blocks[index] : undefined
  if (!block || block.mode === "code" || !block.final || block.raw !== raw) return undefined
  return block
}

export function initialResult(
  text: string,
  key: string | undefined,
  projection: Projection,
  owner: string,
): RenderResult | undefined {
  if (!text) return { text, blocks: [] }
  return cachedRenderResult(text, key, projection, owner) ?? syncRenderResult(text, projection, owner, key)
}

export async function enhanceTextBlock(input: {
  initial: RenderResult | undefined
  owner: string
  cacheKey: string | undefined
  base: string | undefined
  text: string
  index: number
  block: Block
  mode: Exclude<Block["mode"], "code">
  parse: (src: string) => Promise<string>
}): Promise<RenderedBlock> {
  const { block, mode } = input
  const entry = input.base ? blockEntry(input.base, input.index, mode) : undefined
  const key = markdownBlockKey(input.owner, input.cacheKey, input.index, mode)
  const painted = finalFirstPaint(input.initial, input.text, input.index, block.raw)
  if (painted) {
    if (entry) touchCachedMarkdown(entry, { raw: painted.raw, hash: painted.hash, html: painted.html })
    return painted
  }

  if (entry) {
    const cached = getCachedMarkdown(entry)
    if (cached?.raw === block.raw) {
      touchCachedMarkdown(entry, cached)
      return { key, mode, ...cached, final: true }
    }
    traceRenderer(`markdown.parsemiss.${cached ? "raw-mismatch" : "no-entry"}.chars-${block.src.length}`)
  } else {
    traceRenderer(`markdown.parsemiss.no-key.chars-${block.src.length}`)
  }

  const hash = blockHash(block.raw, true)
  const parsed = await input.parse(block.src)
  const sanitizeStarted = rendererClock()
  const safe = sanitizeMarkdown(parsed)
  traceRenderer(`markdown.sanitize.chars-${block.src.length}`, sanitizeStarted)
  if (entry) touchCachedMarkdown(entry, { raw: block.raw, hash, html: safe })
  return { key, mode, raw: block.raw, hash, html: safe, final: true }
}
