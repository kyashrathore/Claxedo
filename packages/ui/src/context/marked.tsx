import type { MarkedExtension, Tokens } from "marked"
import type { BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { markedCodeSpanBoundary } from "./marked-code-span"
import type { ThemeRegistrationResolved } from "@pierre/diffs"

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
} as unknown as ThemeRegistrationResolved

function renderMathInText(
  text: string,
  render: (source: string, options: { displayMode: boolean; throwOnError: boolean }) => string,
): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return render(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: \(...\)
  const inlineMathRegex = /\\\(((?:\\.|[^\\\n])*?)\\\)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return render(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `\\(${math}\\)`
    }
  })

  return result
}

const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/

function createKatexExtension(
  render: (source: string, options: { displayMode: boolean; throwOnError: boolean }) => string,
): MarkedExtension {
  const renderToken = (token: Tokens.Generic) => render(typeof token.text === "string" ? token.text : "", {
    displayMode: token.displayMode === true,
    throwOnError: false,
  })
  return {
    extensions: [
      {
        name: "inlineKatex",
        level: "inline",
        start(src) {
          const index = src.indexOf("\\(")
          if (index === -1) return
          return index
        },
        tokenizer(src) {
          const match = src.match(inlineMathRegex)
          if (!match) return
          return {
            type: "inlineKatex",
            raw: match[0],
            text: match[1].trim(),
            displayMode: false,
          }
        },
        renderer: renderToken,
      },
      {
        name: "blockKatex",
        level: "block",
        tokenizer(src) {
          const match = src.match(blockMathRegex)
          if (!match) return
          return {
            type: "blockKatex",
            raw: match[0],
            text: match[1].trim(),
            displayMode: true,
          }
        },
        renderer: renderToken,
      },
    ],
  }
}

async function renderMathExpressions(html: string) {
  if (!html.includes("$$") && !html.includes("\\(")) return html
  const katex = await import("katex")
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part, katex.default.renderToString)
    })
    .join("")
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

    let language = lang || "text"
    if (!(language in bundledLanguages)) {
      language = "text"
    }
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language as BundledLanguage)
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

function loadJsParser() {
  jsParser ??= Promise.all([
    import("marked"),
    import("marked-shiki"),
    import("katex"),
    import("shiki"),
    ensureOpenCodeTheme(),
  ]).then(([{ marked }, { default: markedShiki }, katex, { addClassToHast, bundledLanguages }, pierre]) => {
    return marked.use(
      markedCodeSpanBoundary,
      {
        renderer: {
          html: renderMarkdownHtml,
          link({ href, title, text }) {
            const titleAttr = title ? ` title="${title}"` : ""
            return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
          },
        },
      },
      createKatexExtension(katex.default.renderToString),
      markedShiki({
        async highlight(code, lang) {
          const highlighter = await pierre.getSharedHighlighter({
            themes: ["OpenCode"],
            langs: [],
            preferredHighlighter: "shiki-wasm",
          })
          if (!(lang in bundledLanguages)) lang = "text"
          if (!highlighter.getLoadedLanguages().includes(lang)) await highlighter.loadLanguage(lang as BundledLanguage)
          return highlighter.codeToHtml(code, {
            lang: lang || "text",
            theme: "OpenCode",
            tabindex: false,
            transformers: [{
              name: "opencode:language-class",
              code(node) {
                addClassToHast(node, `language-${lang || "text"}`)
              },
            }],
          })
        },
      }),
    )
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
