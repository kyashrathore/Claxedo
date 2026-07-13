/**
 * Markdown serialization for the shared rich-text editor.
 *
 * The editor works in ProseMirror/Tiptap docs, but callers persist a plain
 * markdown string (e.g. a stream description used across MCP tools, summaries
 * and recaps). prosemirror-markdown does the heavy lifting; we only re-key its
 * default node/mark handlers to Tiptap's StarterKit + Link schema names
 * (`codeBlock` not `code_block`, `bold` not `strong`, …).
 */
import MarkdownIt from "markdown-it"
import { MarkdownParser, MarkdownSerializer } from "prosemirror-markdown"

const serializer = new MarkdownSerializer(
  {
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node))
    },
    codeBlock(state, node) {
      const language = (node.attrs.language as string) || ""
      state.write("```" + language + "\n")
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write("```")
      state.closeBlock(node)
    },
    heading(state, node) {
      state.write(state.repeat("#", node.attrs.level as number) + " ")
      state.renderInline(node)
      state.closeBlock(node)
    },
    horizontalRule(state, node) {
      state.write("---")
      state.closeBlock(node)
    },
    bulletList(state, node) {
      state.renderList(node, "  ", () => "- ")
    },
    orderedList(state, node) {
      const start = (node.attrs.start as number) || 1
      const maxWidth = String(start + node.childCount - 1).length
      const space = state.repeat(" ", maxWidth + 2)
      state.renderList(node, space, (index) => {
        const label = String(start + index)
        return state.repeat(" ", maxWidth - label.length) + label + ". "
      })
    },
    listItem(state, node) {
      state.renderContent(node)
    },
    paragraph(state, node) {
      state.renderInline(node)
      state.closeBlock(node)
    },
    text(state, node) {
      state.text(node.text ?? "")
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n")
          return
        }
      }
    },
  },
  {
    bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    code: { open: "`", close: "`", escape: false },
    link: {
      open: () => "[",
      close(_state, mark) {
        const href = mark.attrs.href as string
        const title = mark.attrs.title as string | null
        return "](" + href + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : "") + ")"
      },
    },
  },
)

// prosemirror-markdown pins its own prosemirror-model copy (and Tiptap another),
// so accept the doc loosely and cast at the boundary — it's structurally the
// same ProseMirror node at runtime (proven by the round-trip tests).
export function docToMarkdown(doc: unknown): string {
  return serializer.serialize(doc as never)
}

type Token = { attrGet(name: string): string | null; tag: string; info: string }

function tokens() {
  return {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: { block: "orderedList", getAttrs: (token: Token) => ({ start: +(token.attrGet("start") || 1) }) },
    heading: { block: "heading", getAttrs: (token: Token) => ({ level: +token.tag.slice(1) }) },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: { block: "codeBlock", getAttrs: (token: Token) => ({ language: token.info || "" }), noCloseToken: true },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: { mark: "link", getAttrs: (token: Token) => ({ href: token.attrGet("href"), title: token.attrGet("title") || null }) },
    code_inline: { mark: "code", noCloseToken: true },
  }
}

export function markdownToJSON(schema: unknown, markdown: string): Record<string, unknown> {
  const parser = new MarkdownParser(schema as never, MarkdownIt({ html: false }), tokens() as never)
  return parser.parse(markdown).toJSON() as Record<string, unknown>
}
