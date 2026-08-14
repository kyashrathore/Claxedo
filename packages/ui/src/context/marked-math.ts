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

export function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}
