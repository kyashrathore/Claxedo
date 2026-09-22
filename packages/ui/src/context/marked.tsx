import type { MarkedExtension, Tokens } from "marked"
import type { BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { isKeyOf } from "../utils/record"
import { markedCodeSpanBoundary } from "./marked-code-span"
import type { ThemeRegistration } from "@pierre/diffs"

export const OpenCodeTheme = {
  name: "OpenCode",
  bg: "var(--background-stronger)",
  fg: "var(--text-base)",
  colors: {
    "editor.background": "var(--background-stronger)",
    "editor.foreground": "var(--text-base)",
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
    "gitDecoration.modifiedResourceForeground": "var(--syntax-diff-unknown)",
    // "gitDecoration.conflictingResourceForeground": "#ffca00",
    // "gitDecoration.modifiedResourceForeground": "#1a76d4",
    // "gitDecoration.untrackedResourceForeground": "#00cab1",
    // "gitDecoration.ignoredResourceForeground": "#84848A",
    // "terminal.titleForeground": "#adadb1",
    // "terminal.titleInactiveForeground": "#84848A",
    // "terminal.background": "#141415",
    // "terminal.foreground": "#adadb1",
    // "terminal.ansiBlack": "#141415",
    // "terminal.ansiRed": "#ff2e3f",
    // "terminal.ansiGreen": "#0dbe4e",
    // "terminal.ansiYellow": "#ffca00",
    // "terminal.ansiBlue": "#008cff",
    // "terminal.ansiMagenta": "#c635e4",
    // "terminal.ansiCyan": "#08c0ef",
    // "terminal.ansiWhite": "#c6c6c8",
    // "terminal.ansiBrightBlack": "#141415",
    // "terminal.ansiBrightRed": "#ff2e3f",
    // "terminal.ansiBrightGreen": "#0dbe4e",
    // "terminal.ansiBrightYellow": "#ffca00",
    // "terminal.ansiBrightBlue": "#008cff",
    // "terminal.ansiBrightMagenta": "#c635e4",
    // "terminal.ansiBrightCyan": "#08c0ef",
    // "terminal.ansiBrightWhite": "#c6c6c8",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: {
        foreground: "var(--syntax-property)", // maybe attribute
      },
    },
    {
      scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: ["meta.object.member"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "variable.parameter.function",
        "meta.jsx.children",
        "meta.block",
        "meta.tag.attributes",
        "entity.name.constant",
        "meta.embedded.expression",
        "meta.template.expression",
        "string.other.begin.yaml",
        "string.other.end.yaml",
      ],
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["entity.name.function", "support.type.primitive"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.class.component"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: "keyword",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "entity.name.tag.yaml",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: {
        foreground: "var(--syntax-operator)",
      },
    },
    {
      scope: ["storage", "storage.type"],
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
        "entity.name.tag",
      ],
      settings: {
        foreground: "var(--syntax-string)",
      },
    },
    {
      scope: "support",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
      settings: {
        foreground: "var(--syntax-object)",
      },
    },
    {
      scope: "meta.property-name",
      settings: {
        foreground: "var(--syntax-property)",
      },
    },
    {
      scope: "variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "variable.other",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "markup.deleted",
        "meta.diff.header.from-file",
        "punctuation.definition.deleted",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: {
        foreground: "var(--syntax-critical)",
      },
    },
    {
      scope: "carriage-return",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: "string source",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "string variable",
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: {
        foreground: "var(--syntax-regexp)",
      },
    },
    {
      scope: "support.constant",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: "support.variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "meta.module-reference",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "punctuation.definition.list.begin.markdown",
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.quote",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.italic",
      settings: {
        fontStyle: "italic",
        // foreground: "",
      },
    },
    {
      scope: "markup.bold",
      settings: {
        fontStyle: "bold",
        foreground: "var(--text-strong)",
      },
    },
    {
      scope: [
        "markup.raw",
        "markup.inserted",
        "meta.diff.header.to-file",
        "punctuation.definition.inserted",
        "markup.changed",
        "punctuation.definition.changed",
        "markup.ignored",
        "markup.untracked",
      ],
      settings: {
        foreground: "var(--text-base)",
      },
    },
    {
      scope: "meta.diff.range",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.diff.header",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.separator",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.output",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.export.default",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: {
        fontStyle: "underline",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "token.info-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "token.warn-token",
      settings: {
        foreground: "var(--syntax-warning)",
      },
    },
    {
      scope: "token.debug-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
  ],
  semanticTokenColors: {
    comment: "var(--syntax-comment)",
    string: "var(--syntax-string)",
    number: "var(--syntax-constant)",
    regexp: "var(--syntax-regexp)",
    keyword: "var(--syntax-keyword)",
    variable: "var(--syntax-variable)",
    parameter: "var(--syntax-variable)",
    property: "var(--syntax-property)",
    function: "var(--syntax-primitive)",
    method: "var(--syntax-primitive)",
    type: "var(--syntax-type)",
    class: "var(--syntax-type)",
    namespace: "var(--syntax-type)",
    enumMember: "var(--syntax-primitive)",
    "variable.constant": "var(--syntax-constant)",
    "variable.defaultLibrary": "var(--syntax-unknown)",
  },
  // `ThemeRegistration`, not `...Resolved`: this theme carries `tokenColors` rather than
  // the resolved `settings`, and shiki resolves the two when it loads the theme.
} satisfies ThemeRegistration

async function renderMathExpressions(html: string) {
  if (!html.includes("$$") && !html.includes("\\(")) return html
  const math = await import("./marked-math")
  return math.renderMathExpressions(html)
}

/**
 * Shiki emits `<pre class="shiki OpenCode"><code>` and drops the
 * `class="language-X"` that marked's own code renderer puts on the `<code>`.
 * Consumers read that class back off the DOM to recover a block's language —
 * session-ui's markdown decorator uses it for code metadata and, critically, it
 * is how ```mermaid fences are found. Highlighting must not cost the language.
 *
 * The name used is the one actually highlighted with (unknown languages having
 * been folded to `text`), which matches what session-ui stamps on the code
 * blocks it builds itself.
 */
async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const [{ bundledLanguages, addClassToHast }, { getSharedHighlighter }] = await Promise.all([
    import("shiki"),
    ensureOpenCodeTheme(),
  ])
  const highlighter = await getSharedHighlighter({
    themes: ["OpenCode"],
    langs: [],
    preferredHighlighter: "shiki-wasm",
  })

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match
    const code = escapedCode
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

    // `text` is shiki's plain-text pseudo-language: it has no grammar in `bundledLanguages`
    // and must not be handed to `loadLanguage`, which is why the two are typed apart here.
    const requested = lang || "text"
    const bundled: BundledLanguage | undefined = isKeyOf(bundledLanguages, requested) ? requested : undefined
    const language: BundledLanguage | "text" = bundled ?? "text"
    if (bundled && !highlighter.getLoadedLanguages().includes(bundled)) {
      await highlighter.loadLanguage(bundledLanguages[bundled])
    }

    const highlighted = highlighter.codeToHtml(code, {
      lang: language,
      theme: "OpenCode",
      tabindex: false,
      transformers: [{
        name: "opencode:language-class",
        code(node) {
          addClassToHast(node, `language-${language}`)
        },
      }],
    })
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

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

let openCodeThemeRegistration: Promise<typeof import("@pierre/diffs")> | undefined

export function ensureOpenCodeTheme() {
  openCodeThemeRegistration ??= import("@pierre/diffs").then((pierre) => {
    pierre.registerCustomTheme("OpenCode", () => Promise.resolve(OpenCodeTheme))
    return pierre
  })
  return openCodeThemeRegistration
}

let jsParser: Promise<{ parse(markdown: string): string | Promise<string> }> | undefined

function createNativeParseScheduler(maxConcurrent: number) {
  let active = 0
  const queued: Array<() => void> = []

  return function schedule<T>(run: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1
        Promise.resolve()
          .then(run)
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            queued.shift()?.()
          })
      }
      if (active < maxConcurrent) {
        start()
        return
      }
      queued.push(start)
    })
  }
}

/** Shared syntax policy for immediate paint and asynchronous enhancement. */
export const transcriptMarkdownExtensions: MarkedExtension[] = [
  markedCodeSpanBoundary,
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
        const withMath = await renderMathExpressions(html)
        return highlightCodeBlocks(withMath)
      },
    }
  })
  return jsParser
}

export function createMarkdownParser(nativeParser?: NativeMarkdownParser) {
  if (nativeParser) {
    const scheduleNativeParse = createNativeParseScheduler(2)
    return {
      async parse(markdown: string): Promise<string> {
        try {
          const html = await scheduleNativeParse(() => nativeParser(markdown))
          const withMath = await renderMathExpressions(html)
          return highlightCodeBlocks(withMath)
        } catch {
          return (await loadJsParser()).parse(markdown)
        }
      },
    }
  }

  return {
    async parse(markdown: string) {
      return (await loadJsParser()).parse(markdown)
    },
  }
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => {
    return createMarkdownParser(props.nativeParser)
  },
})
