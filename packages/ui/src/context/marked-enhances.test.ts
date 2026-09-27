import { expect, test } from "bun:test"
import { Marked } from "marked"
import { createMarkdownParser, markdownEnhances, transcriptMarkdownExtensions } from "./marked"

const markdowns = [
  "Plain **bold**, `code` and a [link](https://example.com).",
  "- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quoted",
  "Display math:\n\n$$a+b=c$$",
  "Escaped parentheses \\(x\\) stay prose.",
  "Inline math \\\\(x\\\\) in prose.",
  "```ts\nconst fenced = 1\n```",
  "An indented block:\n\n    const indented = 1\n\nAfter it.",
]

test("the asynchronous parse changes marked's synchronous output exactly when markdownEnhances says so", async () => {
  const sync = new Marked(...transcriptMarkdownExtensions)
  const parser = createMarkdownParser()
  const seen = await Promise.all(
    markdowns.map(async (markdown) => {
      const first = sync.parse(markdown, { async: false })
      return { markdown, changed: (await parser.parse(markdown)) !== first, enhances: markdownEnhances(first) }
    }),
  )
  expect(seen.map((row) => ({ markdown: row.markdown, changed: row.changed }))).toEqual(seen.map((row) => ({ markdown: row.markdown, changed: row.enhances })))
  expect(seen.filter((row) => row.enhances).map((row) => row.markdown)).toEqual([markdowns[2], markdowns[4], markdowns[5], markdowns[6]])
})
