/**
 * Markdown for assistant/plan rows: marked for structure, then a strict
 * allowlist sanitizer over a detached DOM — no raw HTML survives that isn't
 * on the list, and no attribute survives that can carry script. Same posture
 * as the main app's sanitizer, sized for this package.
 */

import { marked } from "marked"

const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "details", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "input", "li", "ol", "p", "pre", "strong", "summary", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  input: new Set(["type", "checked", "disabled"]),
  td: new Set(["align"]),
  th: new Set(["align"]),
  code: new Set(["class"]),
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: true })
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  sanitize(doc.body)
  return doc.body.innerHTML
}

function sanitize(node: Element) {
  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap unknown elements: keep their text, drop the markup.
      child.replaceWith(...child.childNodes)
      continue
    }
    const allowed = ALLOWED_ATTRS[tag]
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase()
      if (!allowed?.has(name)) {
        child.removeAttribute(attr.name)
        continue
      }
      if (name === "href" && !/^(https?:|mailto:|#)/.test(attr.value.trim())) {
        child.removeAttribute(attr.name)
      }
    }
    if (tag === "a") {
      child.setAttribute("target", "_blank")
      child.setAttribute("rel", "noreferrer noopener")
    }
    sanitize(child)
  }
}
