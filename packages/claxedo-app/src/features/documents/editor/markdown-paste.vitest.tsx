import { describe, expect, test } from "vitest"
import { markdownFromPaste } from "@/features/documents/editor/markdown-paste"

/**
 * The branch the paste plugin decides on. Driving a real paste needs a
 * `ClipboardEvent`, which this DOM does not implement; the plugin is kept thin
 * so the decision it makes is testable on its own and the rest is the editor's
 * own parse.
 */
describe("pasting into a markdown document", () => {
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
})
