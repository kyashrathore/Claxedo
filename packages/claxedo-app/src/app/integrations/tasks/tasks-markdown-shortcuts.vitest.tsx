import { describe, expect, test } from "vitest"
import { Editor } from "@tiptap/core"
import { documentRichEditorExtensions } from "@/features/documents/editor/rich-extensions"

/**
 * The markdown shortcuts a Tasks description is expected to have, driven
 * through the production extension set the Tasks port mounts.
 *
 * Typed one character at a time through `handleTextInput`, which is the prop
 * Tiptap registers its input rules on — a `beforeinput` event on the mounted
 * editor is not enough, because the test DOM produces neither the mutation nor
 * the selection ProseMirror reads a keystroke from.
 */
function typed(text: string) {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: documentRichEditorExtensions(), content: "", contentType: "markdown" })
  for (const character of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp("handleTextInput", (rule) => rule(editor.view, from, to, character))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to))
  }
  const result = { html: editor.getHTML(), markdown: editor.getMarkdown() }
  editor.destroy()
  element.remove()
  return result
}

describe("markdown shortcuts in a Tasks description", () => {
  test("a hash makes a heading, and the stored value is still the markdown for one", () => {
    const { html, markdown } = typed("# Title")

    expect(html).toContain("<h1>Title</h1>")
    expect(markdown.trim()).toBe("# Title")
  })

  test("two hashes make a second-level heading", () => {
    expect(typed("## Plan").html).toContain("<h2>Plan</h2>")
  })

  test("a dash makes a bullet list", () => {
    const { html, markdown } = typed("- one")

    expect(html).toContain("<ul>")
    expect(html).toContain("one")
    expect(markdown.trim()).toBe("- one")
  })

  test("a digit and a dot make an ordered list", () => {
    expect(typed("1. first").html).toContain("<ol>")
  })

  test("an angle bracket makes a quote", () => {
    expect(typed("> quoted").html).toContain("<blockquote>")
  })

  // The rule completes on the character after the fence, which is where a
  // language would go; three backticks alone are still being typed.
  test("a backtick fence makes a code block", () => {
    expect(typed("```js ").html).toContain("<pre>")
  })
})
