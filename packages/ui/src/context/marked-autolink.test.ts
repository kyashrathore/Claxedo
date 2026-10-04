import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { markedTranscriptAutolink, transcriptLinkPrefixes } from "./marked"

const parser = new Marked(markedTranscriptAutolink, {
  renderer: {
    link({ href, text }) {
      return `<a href="${href}" class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

const parse = (markdown: string) => parser.parse(markdown, { async: false })

describe("prose autolinking", () => {
  test("links every prefix GFM leaves inert", async () => {
    expect(parse("It landed in file:///Users/dev/notes.md already.")).toBe(
      '<p>It landed in <a href="file:///Users/dev/notes.md" class="external-link" target="_blank"' +
        ' rel="noopener noreferrer">file:///Users/dev/notes.md</a> already.</p>\n',
    )
    expect(parse("open vscode://file/Users/dev/notes.md:12 now")).toContain(
      'href="vscode://file/Users/dev/notes.md:12"',
    )
    expect(parse("see claxedo://documents/open?id=doc_1 for it")).toContain(
      'href="claxedo://documents/open?id=doc_1"',
    )
    expect(parse("write to mailto:dev@example.com")).toContain('href="mailto:dev@example.com"')
  })

  test("covers the closed list and nothing else", () => {
    for (const prefix of transcriptLinkPrefixes) {
      expect(parse(`go to ${prefix}example/path here`)).toContain(`href="${prefix}example/path"`)
    }
    expect(parse("run javascript:alert(1) never")).toBe("<p>run javascript:alert(1) never</p>\n")
    expect(parse("read data:text/html,<b>x</b> never")).not.toContain("<a href")
    expect(parse("mount smb://share/x never")).not.toContain("<a href")
  })

  test("leaves the URL where the author put it", () => {
    expect(parse("`file:///Users/dev/notes.md` stays code")).toBe(
      "<p><code>file:///Users/dev/notes.md</code> stays code</p>\n",
    )
    expect(parse("```\nfile:///Users/dev/notes.md\n```")).not.toContain("<a href")
    expect(parse("[notes](file:///Users/dev/notes.md)")).toBe(
      '<p><a href="file:///Users/dev/notes.md" class="external-link" target="_blank"' +
        ' rel="noopener noreferrer">notes</a></p>\n',
    )
    expect(parse("[file:///Users/dev/notes.md](https://example.com)")).toContain('href="https://example.com"')
    expect(parse("[file:///Users/dev/notes.md](https://example.com)")).not.toContain('href="file://')
  })

  test("stops where the sentence does", () => {
    expect(parse("saved to file:///Users/dev/notes.md.")).toContain('href="file:///Users/dev/notes.md"')
    expect(parse("saved to file:///Users/dev/notes.md.")).toContain("notes.md</a>.")
    expect(parse("(file:///Users/dev/notes.md)")).toContain('href="file:///Users/dev/notes.md"')
    expect(parse("(file:///Users/dev/notes.md)")).toContain("notes.md</a>)")
  })

  test("keeps GFM's own autolinking of http and email", () => {
    expect(parse("docs at https://en.wikipedia.org/wiki/Ruby_(gem) here")).toContain(
      'href="https://en.wikipedia.org/wiki/Ruby_(gem)"',
    )
    expect(parse("mail dev@example.com back")).toContain('href="mailto:dev@example.com"')
    expect(parse("visit www.example.com today")).toContain('href="http://www.example.com"')
  })
})
