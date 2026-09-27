import DOMPurify from "dompurify"
import { createByteBoundedCache } from "./byte-bounded-cache"
import { transcriptLinkUriPattern } from "./transcript-link"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const cache = createByteBoundedCache<string, MarkdownCacheEntry>(
  { entries: 4096, bytes: 8_000_000 },
  (_key, value) => value.raw.length + value.html.length,
)

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

function hardenSvgCss(css: string) {
  return css
    .replace(CSS_AT_RULE, "@blocked")
    .replace(CSS_URL, (rule, _quote, target: string) => (target.trim().startsWith("#") ? rule : "none"))
}

const svgConfig = {
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
  return cache.peek(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.set(key, value)
}

const mermaidCache = createByteBoundedCache<string, string>(
  { entries: 256, bytes: 2_000_000 },
  (source, svg) => source.length + svg.length,
)

export function getCachedMermaidSvg(source: string): string | undefined {
  return mermaidCache.get(source)
}

export function touchCachedMermaidSvg(source: string, svg: string) {
  if (!svg) return
  mermaidCache.set(source, svg)
}
