import { Editor } from "@tiptap/core"
import Link from "@tiptap/extension-link"
import StarterKit from "@tiptap/starter-kit"
import { describe, expect, test } from "vitest"
import { docToMarkdown, markdownToJSON } from "./markdown"

function headlessEditor() {
  return new Editor({ element: document.createElement("div"), extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }), Link.configure({ openOnClick: false })] })
}

describe("rich-text markdown", () => {
  test("round-trips headings, emphasis, code, lists, quotes and links", () => {
    const editor = headlessEditor()
    const markdown = ["# Ship it", "", "A **bold** and *italic* and `inline` note with a [link](https://claxedo.dev).", "", "- first", "- second", "", "> keep it flat"].join("\n")
    editor.commands.setContent(markdownToJSON(editor.schema, markdown))
    const out = docToMarkdown(editor.state.doc)
    expect(out).toContain("# Ship it")
    expect(out).toContain("**bold**")
    expect(out).toContain("*italic*")
    expect(out).toContain("`inline`")
    expect(out).toContain("[link](https://claxedo.dev)")
    expect(out).toContain("- first")
    expect(out).toContain("- second")
    expect(out).toContain("> keep it flat")
    editor.destroy()
  })

  test("an empty document serializes to an empty string", () => {
    const editor = headlessEditor()
    expect(editor.isEmpty).toBe(true)
    expect(docToMarkdown(editor.state.doc).trim()).toBe("")
    editor.destroy()
  })

  test("ordered lists keep their numbering", () => {
    const editor = headlessEditor()
    editor.commands.setContent(markdownToJSON(editor.schema, "1. one\n2. two\n3. three"))
    const out = docToMarkdown(editor.state.doc)
    expect(out).toContain("1. one")
    expect(out).toContain("2. two")
    expect(out).toContain("3. three")
    editor.destroy()
  })
})
