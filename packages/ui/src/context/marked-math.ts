import katex from "katex"
// KaTeX's CSS rides with this lazily-imported module (see styles/index.css),
// so the .katex* rules and their 21 @font-face declarations stay out of the
// render-blocking main stylesheet. Every .katex element in the app is produced
// by renderToString below, so loading this module always precedes needing it.
import "katex/dist/katex.min.css"

function renderMathInText(text: string): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: \(...\)
  const inlineMathRegex = /\\\(((?:\\.|[^\\\n])*?)\\\)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `\\(${math}\\)`
    }
  })

  return result
}

// A tag is never math input: attribute values live inside it (`<a title="$$…">`),
// and rewriting there corrupts the markup itself. The lookahead requires a real
// tag start (`<em>`, `</em>`, `<!-- -->`); a literal `<` in text stays text.
// The quoted-attribute alternatives keep a `>` inside quotes from ending the
// tag early.
const tagPattern = /(<(?=[a-zA-Z/!])(?:"[^"]*"|'[^']*'|[^'">])*>)/g
const codeBoundary = /^<(\/)?(pre|code|kbd)(?=[\s/>])/i

export function renderMathExpressions(html: string): string {
  // Alternating text/tag split: even indices are text between tags (where math
  // belongs), odd indices are whole tags (passed through byte-for-byte).
  const parts = html.split(tagPattern)
  let codeDepth = 0
  let result = ""

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i % 2 === 1) {
      const boundary = codeBoundary.exec(part)
      if (boundary && !part.endsWith("/>")) {
        codeDepth = Math.max(0, codeDepth + (boundary[1] ? -1 : 1))
      }
      result += part
      continue
    }
    result += codeDepth > 0 ? part : renderMathInText(part)
  }

  return result
}
