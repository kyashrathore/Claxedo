import { afterEach, describe, expect, test } from "vitest"
import { Editor } from "@tiptap/core"
import { Slice } from "@tiptap/pm/model"
import { markdownFromPaste } from "@/features/documents/editor/markdown-paste"
import { documentRichEditorExtensions } from "@/features/documents/editor/rich-extensions"

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function mountEditor(markdown: string) {
  const element = window.document.createElement("div")
  window.document.body.append(element)
  const editor = new Editor({
    element,
    extensions: documentRichEditorExtensions(),
    content: markdown,
    contentType: "markdown",
  })
  editors.push(editor)
  return editor
}

/**
 * `ClipboardEvent` is not implemented in this DOM, so the plugin is driven
 * through the prop ProseMirror would call, over a real cancelable event
 * carrying the two clipboard reads it makes; every other MIME type reads
 * empty, as it does from a clipboard holding only text.
 */
function paste(editor: Editor, text: string, html = "") {
  const event = new Event("paste", { cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : "") },
  })
  const handled = editor.view.someProp("handlePaste", (handler) =>
    handler(editor.view, event as ClipboardEvent, Slice.empty),
  )
  return { handled: handled === true, prevented: event.defaultPrevented }
}

describe("the branch a paste takes", () => {
  test("plain text alone is markdown, and is handed on to be parsed", () => {
    expect(markdownFromPaste({ html: "", text: "# Title\n\n- one\n", inCode: false })).toBe("# Title\n\n- one\n")
  })

  // An editor or a browser that supplies HTML has already described the
  // structure; re-reading its plain text would throw that away.
  test("text that arrives with HTML beside it is left to the HTML path", () => {
    expect(markdownFromPaste({ html: "<h1>Title</h1>", text: "# Title", inCode: false })).toBeUndefined()
  })

  // Measured before this branch existed: pasting `# not a heading` into a
  // fence produced an h1 after the fence and moved the caret out of it.
  test("text pasted inside a code block is code, and is left to the default paste", () => {
    expect(markdownFromPaste({ html: "", text: "# a comment\n- not a list", inCode: true })).toBeUndefined()
  })

  test("an empty clipboard is not a document", () => {
    expect(markdownFromPaste({ html: "", text: "   \n", inCode: false })).toBeUndefined()
    expect(markdownFromPaste({ html: "", text: "", inCode: false })).toBeUndefined()
  })

  test("text outside the rich contract is not markdown this editor can hold", () => {
    expect(markdownFromPaste({ html: "", text: "keep <!-- required instruction --> this\n", inCode: false })).toBeUndefined()
  })
})

describe("pasting into a markdown document", () => {
  test("a lone paragraph joins the sentence the caret is in", () => {
    const editor = mountEditor("hello world")
    editor.commands.setTextSelection(7)

    expect(paste(editor, "nice ")).toEqual({ handled: true, prevented: true })

    expect(editor.getHTML()).toBe("<p>hello nice world</p>")
    expect(editor.getMarkdown()).toBe("hello nice world")
  })

  test("a document keeps its blocks", () => {
    const editor = mountEditor("")

    expect(paste(editor, "# Title\n\n- one\n- two\n")).toEqual({ handled: true, prevented: true })

    expect(editor.getHTML()).toContain("<h1>Title</h1>")
    expect(editor.$doc.querySelectorAll("listItem")).toHaveLength(2)
  })

  /**
   * The comment has no node in this schema: parsing it produced the inline
   * fragment `<"keep ", paragraph, " this">`, which the paragraph rejects.
   * Leaving the paste unhandled hands it to ProseMirror, which inserts the
   * text with the comment still in it.
   */
  test("text the editor cannot represent is left to the default paste", () => {
    const editor = mountEditor("hello world")

    expect(paste(editor, "keep <!-- required instruction --> this\n")).toEqual({ handled: false, prevented: false })

    expect(editor.getHTML()).toBe("<p>hello world</p>")
  })

  test("a paste inside a code block stays with the default paste", () => {
    const editor = mountEditor("```\ncode\n```\n")
    editor.commands.setTextSelection(4)

    expect(paste(editor, "# heading")).toEqual({ handled: false, prevented: false })

    expect(editor.getHTML()).toContain("<pre><code>code</code></pre>")
  })
})
