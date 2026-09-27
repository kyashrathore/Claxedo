import DOMPurify from "dompurify"
import { transcriptLinkUriPattern } from "./transcript-link"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

export const markdownCacheLimits = {
  entries: 4096,
  bytes: 8_000_000,
}
const cache = new Map<string, MarkdownCacheEntry>()
let totalBytes = 0

function entryBytes(value: MarkdownCacheEntry) {
  return value.raw.length + value.html.length
}
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  ALLOWED_URI_REGEXP: transcriptLinkUriPattern,
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

const markdownPurifier = typeof window === "undefined" || !DOMPurify.isSupported ? undefined : DOMPurify(window)
markdownPurifier?.setConfig(config)
markdownPurifier?.addHook("afterSanitizeAttributes", (node: Element) => {
  if (!(node instanceof HTMLAnchorElement)) return
  if (node.target !== "_blank") return

  const rel = node.getAttribute("rel") ?? ""
  const set = new Set(rel.split(/\s+/).filter(Boolean))
  set.add("noopener")
  set.add("noreferrer")
  node.setAttribute("rel", Array.from(set).join(" "))
})

export function sanitizeMarkdown(html: string) {
  return markdownPurifier?.isSupported ? markdownPurifier.sanitize(html) : ""
}

const SAFE_SVG_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const CSS_AT_RULE = /@(?:import|namespace)\b/gi
const CSS_URL = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi

export function hardenSvgCss(css: string) {
  return css
    .replace(CSS_AT_RULE, "@blocked")
    .replace(CSS_URL, (rule, _quote, target: string) => (target.trim().startsWith("#") ? rule : "none"))
}

export const svgConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ALLOWED_URI_REGEXP: SAFE_SVG_URI,
  ADD_TAGS: ["style"],
  FORBID_TAGS: [
    "script",
    "foreignObject",
    "use",
    "image",
    "feImage",
    "animate",
    "animateTransform",
    "set",
    "handler",
    "listener",
  ],
  FORBID_CONTENTS: ["script", "foreignObject"],
  FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onbegin", "onend", "onrepeat", "onfocusin"],
  SANITIZE_NAMED_PROPS: false,
}

type SvgPurifier = {
  isSupported: boolean
  sanitize(source: string, config: typeof svgConfig): string
}

const svgPurifier =
  typeof window === "undefined" || !DOMPurify.isSupported ? undefined : (DOMPurify(window) as SvgPurifier & {
    addHook: (typeof DOMPurify)["addHook"]
  })

svgPurifier?.addHook("afterSanitizeElements", (node) => {
  if (node.nodeName?.toLowerCase() !== "style") return
  node.textContent = hardenSvgCss(node.textContent ?? "")
})

export function sanitizeSvg(svg: string, purifier: SvgPurifier | undefined = svgPurifier) {
  if (!purifier?.isSupported) return ""
  try {
    return purifier.sanitize(svg, svgConfig)
  } catch (error) {
    console.warn("An SVG could not be sanitized, so it is not shown", { error })
    return ""
  }
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  const bytes = entryBytes(value)
  if (bytes > markdownCacheLimits.bytes) return
  const existing = cache.get(key)
  if (existing) {
    totalBytes -= entryBytes(existing)
    cache.delete(key)
  }
  cache.set(key, value)
  totalBytes += bytes

  while (cache.size > markdownCacheLimits.entries || totalBytes > markdownCacheLimits.bytes) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    totalBytes -= entryBytes(oldest[1])
    cache.delete(oldest[0])
  }
}

export const mermaidSvgCacheLimits = {
  entries: 256,
  bytes: 2_000_000,
}
const mermaidCache = new Map<string, string>()
let mermaidBytes = 0

export function getCachedMermaidSvg(source: string): string | undefined {
  const value = mermaidCache.get(source)
  if (value === undefined) return undefined
  mermaidCache.delete(source)
  mermaidCache.set(source, value)
  return value
}

export function touchCachedMermaidSvg(source: string, svg: string) {
  if (!svg) return
  const bytes = source.length + svg.length
  if (bytes > mermaidSvgCacheLimits.bytes) return
  const existing = mermaidCache.get(source)
  if (existing) {
    mermaidBytes -= source.length + existing.length
    mermaidCache.delete(source)
  }
  mermaidCache.set(source, svg)
  mermaidBytes += bytes
  while (mermaidCache.size > mermaidSvgCacheLimits.entries || mermaidBytes > mermaidSvgCacheLimits.bytes) {
    const oldest = mermaidCache.entries().next().value
    if (!oldest) break
    mermaidBytes -= oldest[0].length + oldest[1].length
    mermaidCache.delete(oldest[0])
  }
}
