import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"
import { project } from "./markdown-stream"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, MarkdownCacheEntry>()
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

/**
 * SVG sanitization for rendered mermaid diagrams.
 *
 * `renderMermaidBlocks` in markdown.tsx assigns mermaid's rendered SVG into
 * `innerHTML`, and the diagram source is assistant output — anything that can
 * steer what the model emits (a poisoned file the agent read, tool output, an
 * injected web page) can steer what lands in that sink. Mermaid's own
 * `securityLevel: "strict"` pass used to be the *only* control there, and strict
 * mode is precisely what the advisories against mermaid `>=11.1.0 <11.10.0`
 * bypass. So mermaid's output is treated as untrusted and re-sanitized here.
 *
 * `sanitizeMarkdown`'s `config` above cannot be reused for this: it is an
 * HTML/MathML profile that allows only `svg` and `path`, so every `<g>`,
 * `<text>`, `<rect>` and `<marker>` in a diagram is stripped and what reaches
 * the page is an empty box. SVG needs its own profile.
 */

// Same-document fragments, relative paths, and http(s)/mailto only: DOMPurify's
// default URI allowlist minus the schemes a diagram has no business using
// (ftp/tel/callto/sms/cid/xmpp/matrix). `javascript:`, `data:`, `vbscript:` and
// `blob:` fail every branch — a bare scheme is rejected because the third branch
// requires the run of scheme characters to end in something other than `:`.
const SAFE_SVG_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

// Mirrors DOMPurify's own ATTR_WHITESPACE: the characters a browser discards
// before resolving a URL. Without this `java\tscript:alert(1)` smuggles a
// scheme past the test above and is then reassembled by the parser.
const URI_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g

export function isSafeSvgUri(value: string) {
  return SAFE_SVG_URI.test(value.replace(URI_WHITESPACE, ""))
}

const CSS_AT_RULE = /@(?:import|namespace)\b/gi
const CSS_URL = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi

/**
 * Mermaid ships a diagram's entire theme in a single `<style>` element, so
 * dropping the element leaves correct-but-unstyled shapes. Keep it, and instead
 * neutralize the two things stylesheet text can still do from inside an SVG:
 * pull in a remote sheet (`@import`) and phone home through a resource URL.
 * `url(#…)` is left intact — that is the same-document form mermaid uses for
 * markers and gradients, and rewriting it would cost every arrowhead.
 */
export function hardenSvgCss(css: string) {
  return css
    .replace(CSS_AT_RULE, "@blocked")
    .replace(CSS_URL, (rule, _quote, target: string) => (target.trim().startsWith("#") ? rule : "none"))
}

export const svgConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ALLOWED_URI_REGEXP: SAFE_SVG_URI,
  // Mermaid's theme lives here; the hook below hardens its contents.
  ADD_TAGS: ["style"],
  // Most of these already sit outside DOMPurify's `svg` profile; naming them
  // keeps the policy explicit and pins it if that profile ever widens.
  // `foreignObject` is the classic SVG-sanitizer bypass — it switches namespace
  // to HTML mid-document; `use` can reference an external document; `animate`
  // and `set` can retarget another element's attributes after sanitization.
  //
  // `image`/`feImage` are different: they ARE in the svg profile, and `image` is
  // one of DOMPurify's DEFAULT_DATA_URI_TAGS, which means `<image href="data:…">`
  // is waved through *ahead of* ALLOWED_URI_REGEXP and no URI policy can stop it
  // (verified against DOMPurify 3.3.1). Mermaid emits neither element in any
  // diagram type this app renders, so forbidding them costs nothing and is the
  // only way to close that exemption.
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
  // Drop the subtree as well, so a stripped `foreignObject` cannot spill its
  // markup back into the diagram as text.
  FORBID_CONTENTS: ["script", "foreignObject"],
  // DOMPurify drops every `on*` handler already (they appear in no allowlist).
  // These are pinned because they are what an SVG payload actually reaches for,
  // including the SMIL-only ones that have no HTML equivalent.
  FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onbegin", "onend", "onrepeat", "onfocusin"],
  // Must stay off. It rewrites `id`/`name` to `user-content-*`, which would break
  // mermaid's `#id`-scoped stylesheet and its `url(#marker)` references: the
  // diagram would render unstyled and without arrowheads.
  SANITIZE_NAMED_PROPS: false,
}

type SvgPurifier = {
  isSupported: boolean
  sanitize(source: string, config: typeof svgConfig): string
}

// A dedicated instance, not the shared one: the `<style>` hook below must not run
// during `sanitizeMarkdown`, and markdown's `rel=noopener` hook must not run here.
const svgPurifier =
  typeof window === "undefined" || !DOMPurify.isSupported ? undefined : (DOMPurify(window) as SvgPurifier & {
    addHook: (typeof DOMPurify)["addHook"]
  })

svgPurifier?.addHook("afterSanitizeElements", (node) => {
  // SVG elements report a lowercase `nodeName`; HTML ones report uppercase.
  if (node.nodeName?.toLowerCase() !== "style") return
  node.textContent = hardenSvgCss(node.textContent ?? "")
})

/**
 * Returns "" when the SVG cannot be safely rendered. Callers must treat an empty
 * result as "render nothing" and must never fall back to the raw string: an
 * unrenderable diagram is a far better outcome than an unsanitized one.
 */
export function sanitizeSvg(svg: string, purifier: SvgPurifier | undefined = svgPurifier) {
  if (!purifier?.isSupported) return ""
  try {
    return purifier.sanitize(svg, svgConfig)
  } catch {
    return ""
  }
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(
  text: string,
  cacheKey: string,
  parser: { parse(text: string): string | Promise<string> },
) {
  await Promise.all(
    project(undefined, text, false).blocks.map(async (block, index) => {
      if (block.mode === "code") return
      const key = `${cacheKey}:${index}:${block.mode}`
      const cached = getCachedMarkdown(key)
      if (cached?.raw === block.raw) {
        touchCachedMarkdown(key, cached)
        return
      }
      const hash = checksum(block.raw)
      if (!hash) return
      touchCachedMarkdown(key, {
        raw: block.raw,
        hash,
        html: sanitizeMarkdown(await Promise.resolve(parser.parse(block.src))),
      })
    }),
  )
}
