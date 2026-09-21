import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { transcriptLinkUriAllowed, transcriptMarkdownExtensions } from "./marked"

const parse = (text: string) => new Marked(...transcriptMarkdownExtensions).parse(text, { async: false })

test("linked images render image tokens inside the navigation link", () => {
  expect(parse('[![result](https://example.com/result.png)](https://example.com/original)')).toBe(
    '<p><a href="https://example.com/original" class="external-link" target="_blank" rel="noopener noreferrer"><img src="https://example.com/result.png" alt="result"></a></p>\n',
  )
})

test("links preserve inline formatting and escaped text", () => {
  expect(parse('[**Result** and `file` &amp; details](https://example.com)')).toContain(
    '<strong>Result</strong> and <code>file</code> &amp; details</a>',
  )
})

describe("link scheme policy", () => {
  test("a refused scheme renders the label inert", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "java\tscript:alert(1)",
    ]) {
      const html = parse(`[payload](${href})`)
      expect(html).not.toContain("<a ")
      expect(html).toContain("payload")
    }
  })

  test("relative, fragment and allowlisted links still render", () => {
    expect(parse("[docs](./plan.md)")).toContain('<a href="./plan.md"')
    expect(parse("[jump](#section)")).toContain('<a href="#section"')
    expect(parse("[file](file:///tmp/out.log)")).toContain('<a href="file:///tmp/out.log"')
  })
})

describe("link attribute escaping", () => {
  test("a quote in the title cannot break out of the attribute", () => {
    const html = parse(`[x](https://example.com 'tit"le onmouseover="alert(1)')`)
    expect(html).toContain('title="tit&quot;le onmouseover=&quot;alert(1)"')
    expect(html).not.toContain('onmouseover="alert(1)')
  })

  test("a quote in the href cannot break out of the attribute", () => {
    const html = parse('[x](https://example.com/"onmouseover="alert(1))')
    expect(html).not.toMatch(/href="[^"]*"[^"]*onmouseover=/)
  })
})

describe("transcriptLinkUriAllowed", () => {
  test("admits what the sanitizer keeps and refuses script schemes", () => {
    expect(transcriptLinkUriAllowed("https://example.com")).toBe(true)
    expect(transcriptLinkUriAllowed("#frag")).toBe(true)
    expect(transcriptLinkUriAllowed("docs/plan.md")).toBe(true)
    expect(transcriptLinkUriAllowed("javascript:alert(1)")).toBe(false)
    expect(transcriptLinkUriAllowed("java\tscript:alert(1)")).toBe(false)
    expect(transcriptLinkUriAllowed("data:text/html,<script>")).toBe(false)
  })
})
