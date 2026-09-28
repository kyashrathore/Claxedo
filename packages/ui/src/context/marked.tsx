import type { MarkedExtension, Tokens } from "marked"
import { createSimpleContext } from "./helper"

/** False when the asynchronous parse returns marked's synchronous output with the same extensions unchanged. */
export function markdownEnhances(html: string) {
  return html.includes("$$") || html.includes("\\(")
}

async function renderMathExpressions(html: string) {
  if (!markdownEnhances(html)) return html
  const math = await import("./marked-math")
  return math.renderMathExpressions(html)
}

export function escapeRawMarkdownHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderMarkdownHtml(token: Tokens.HTML | Tokens.Tag) {
  if (/^ {0,3}(?:```|~~~)/.test(token.raw) && token.text !== token.raw) return token.text
  return escapeRawMarkdownHtml(token.text)
}

export const rawMarkdownHtmlDisabled: MarkedExtension = {
  renderer: {
    html: renderMarkdownHtml,
  },
}

/**
 * Closed on purpose: an anchor is worth rendering only where a host has a route
 * for the target — a workspace browser tab, the OS browser, the platform's
 * file-open path, or the OS scheme registry. Anything outside the list, a
 * `javascript:` or `data:` payload included, stays inert text.
 */
export const transcriptLinkPrefixes = [
  "https://",
  "http://",
  "file://",
  "vscode://",
  "claxedo://",
  "mailto:",
] as const

/** DOMPurify 3.3.1's `IS_ALLOWED_URI` scheme set, spelled out: it writes the first four as `(?:f|ht)tps?`. */
const sanitizerDefaultSchemes: readonly string[] = [
  "ftp",
  "ftps",
  "http",
  "https",
  "mailto",
  "tel",
  "callto",
  "sms",
  "cid",
  "xmpp",
  "matrix",
]

const uriSchemes = [
  ...sanitizerDefaultSchemes,
  ...transcriptLinkPrefixes
    .map((prefix) => prefix.slice(0, prefix.indexOf(":")))
    .filter((scheme) => !sanitizerDefaultSchemes.includes(scheme)),
]

/**
 * The href policy for a sanitizer: DOMPurify's default widened by this app's
 * own schemes, never narrowed, so no link that survives sanitization today
 * loses its href. The two branches after the schemes are DOMPurify's own —
 * anything opening with a non-letter (`#fragment`, `/absolute`, `./relative`)
 * and anything whose leading run of scheme characters is not a scheme at all
 * (`notes.md`, `docs/plan.md`). A bare `javascript:`, `data:` or `vbscript:`
 * matches no branch.
 */
export const transcriptLinkUriPattern = new RegExp(
  `^(?:(?:${uriSchemes.join("|")}):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`,
  "i",
)

// Mirrors DOMPurify's own ATTR_WHITESPACE: the characters a browser discards
// before resolving a URL. Without this `java\tscript:alert(1)` smuggles a
// scheme past the pattern above and is then reassembled by the parser.
const uriWhitespace = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g

/**
 * The href admission test shared by the markdown link renderer, the DOM
 * sanitizer config and the transcript click handler — one predicate so a value
 * cannot be emitted by the builder, kept by the sanitizer, yet refused (or
 * silently navigated) at click time.
 */
export function transcriptLinkUriAllowed(href: string) {
  return transcriptLinkUriPattern.test(href.replace(uriWhitespace, ""))
}

/**
 * How far a link runs once prose has started one. A closing paren, bracket or
 * quote ends the run because markdown and prose wrap URLs in those far more
 * often than a URL carries them; sentence punctuation left on the tail is the
 * caller's to trim.
 */
export function transcriptLinkRunSource(prefixes: readonly string[]) {
  const alternation = prefixes.map((prefix) => prefix.replace(/[./]/g, "\\$&")).join("|")
  return `(?:${alternation})[^\\s<>"'\`)\\]]+`
}

/**
 * `http(s)` is left to GFM: marked's own url rule backpedals over balanced
 * parentheses, which a character class cannot do, and the same rule picks up
 * bare `www.` and email addresses. The remaining prefixes have no GFM rule at
 * all, so a `file:///…` or `vscode://…` a model writes in prose is inert
 * without this.
 */
const autolinkSource = transcriptLinkRunSource(
  transcriptLinkPrefixes.filter((prefix) => !prefix.startsWith("http")),
)
const autolinkRule = new RegExp(`^${autolinkSource}`, "i")
const autolinkStart = new RegExp(autolinkSource, "i")
const autolinkTrailing = /[),.;:!?]+$/

/**
 * Emits marked's own `link` token rather than a token of its own, so the anchor
 * comes out of the same renderer as `[text](url)` and GFM's autolink, and the
 * sanitizer and click handler downstream cannot tell the three apart.
 */
export const markedTranscriptAutolink: MarkedExtension = {
  extensions: [
    {
      name: "transcriptAutolink",
      level: "inline",
      start(src) {
        return autolinkStart.exec(src)?.index
      },
      tokenizer(src) {
        // Matches the guard marked puts on its own url rule: a link label is
        // inline-tokenized with `inLink` set, and nesting an anchor is invalid.
        if (this.lexer.state.inLink) return undefined
        const match = autolinkRule.exec(src)
        if (!match) return undefined
        const href = match[0].replace(autolinkTrailing, "")
        if (!href) return undefined
        return {
          type: "link",
          raw: href,
          href,
          title: null,
          text: href,
          tokens: [{ type: "text", raw: href, text: href }],
        }
      },
    },
  ],
}

let jsParser: Promise<{ parse(markdown: string): string | Promise<string> }> | undefined

/** Shared syntax policy for immediate paint and asynchronous enhancement. */
export const transcriptMarkdownExtensions: MarkedExtension[] = [
  markedTranscriptAutolink,
  {
    renderer: {
      html: renderMarkdownHtml,
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        // A refused scheme never becomes an anchor — the label renders inert.
        // href/title are attribute-escaped so a `"` in either cannot break out
        // of its attribute into live markup before the sanitizer runs.
        if (!href || !transcriptLinkUriAllowed(href)) return text
        const titleAttr = title ? ` title="${escapeRawMarkdownHtml(title)}"` : ""
        return `<a href="${escapeRawMarkdownHtml(href)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
  },
]

function loadJsParser() {
  jsParser ??= import("marked").then(({ Marked }) => {
    const parser = new Marked(...transcriptMarkdownExtensions)
    return {
      async parse(markdown: string) {
        const html = await parser.parse(markdown)
        return renderMathExpressions(html)
      },
    }
  })
  return jsParser
}

export function createMarkdownParser() {
  return {
    async parse(markdown: string) {
      return (await loadJsParser()).parse(markdown)
    },
  }
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () => createMarkdownParser(),
})
