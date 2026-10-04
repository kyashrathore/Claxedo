import { describe, expect, test } from "bun:test"
import { renderMathExpressions } from "./marked-math"

describe("renderMathExpressions", () => {
  test("renders $$ and \\(...\\) math found in text", () => {
    expect(renderMathExpressions("<p>area $$x^2$$ here</p>")).toContain("katex-display")
    expect(renderMathExpressions("<p>area \\(x^2\\) here</p>")).toContain("katex")
  })

  test("never rewrites inside a tag — attribute values pass through untouched", () => {
    const html = '<a href="https://example.com/?q=$$1$$" title="$$alert(1)$$">link</a>'
    expect(renderMathExpressions(html)).toBe(html)
  })

  test("a > inside a quoted attribute does not end the tag early", () => {
    const html = '<a title="a>b">see $$x$$</a>'
    expect(renderMathExpressions(html).startsWith('<a title="a>b">see <span class="katex-display">')).toBe(true)
  })

  test("leaves pre, code and kbd contents alone", () => {
    const html = "<p>$$y$$</p><pre><code>$$x$$</code></pre><p><code>\\(z\\)</code></p>"
    const result = renderMathExpressions(html)
    expect(result).toContain("<code>$$x$$</code>")
    expect(result).toContain("<code>\\(z\\)</code>")
    expect(result.match(/katex-display/g)).toHaveLength(1)
  })

  test("plain text without delimiters is unchanged", () => {
    const html = "<p>nothing to render</p>"
    expect(renderMathExpressions(html)).toBe(html)
  })
})
