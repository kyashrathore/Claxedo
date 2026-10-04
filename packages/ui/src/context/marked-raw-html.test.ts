import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import markedShiki from "marked-shiki"
import { rawMarkdownHtmlDisabled } from "./marked"

describe("raw Markdown HTML", () => {
  test("renders raw block and inline tags as text", async () => {
    const parser = new Marked(rawMarkdownHtmlDisabled)
    const html = await parser.parse("<section>raw block</section>\n\ntext <b>raw inline</b>")

    expect(html).toContain("&lt;section&gt;raw block&lt;/section&gt;")
    expect(html).toContain("&lt;b&gt;raw inline&lt;/b&gt;")
    expect(html).not.toContain("<section>")
    expect(html).not.toContain("<b>")
  })

  test("keeps Markdown-owned structure enabled", async () => {
    const parser = new Marked(rawMarkdownHtmlDisabled)

    expect(await parser.parse("**strong** and [docs](https://example.com)")).toContain(
      '<strong>strong</strong> and <a href="https://example.com">docs</a>',
    )
  })

  test("keeps syntax-highlighter output for nested fenced code", async () => {
    const parser = new Marked(
      rawMarkdownHtmlDisabled,
      markedShiki({
        async highlight(code, language) {
          return '<pre data-renderer-owned><code class="language-' + language + '">' + code + "</code></pre>"
        },
      }),
    )

    const html = await parser.parse("- diagram:\n\n  ~~~mermaid\n  flowchart TD\n    A-->B\n  ~~~\n")

    expect(html).toContain('<pre data-renderer-owned><code class="language-mermaid">')
    expect(html).not.toContain("&lt;pre data-renderer-owned")
  })
})
