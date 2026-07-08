// Markdown <-> TipTap document conversion.

function parseContent(content: string) {
  const value = content.trim()
  if (!value) return null
  if (!value.startsWith("{") && !value.startsWith("[")) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function textMarks(text: string, marks?: Array<{ type?: string }>) {
  if (!marks?.length) return text
  return marks.reduce((acc, mark) => {
    if (mark.type === "bold") return `**${acc}**`
    if (mark.type === "italic") return `*${acc}*`
    if (mark.type === "strike") return `~~${acc}~~`
    if (mark.type === "code") return `\`${acc}\``
    if (mark.type === "highlight") return `==${acc}==`
    if (mark.type === "underline") return `++${acc}++`
    return acc
  }, text)
}

/** Loosely-typed TipTap JSON node (recursive, untyped at the editor boundary). */
type TipTapNode = Record<string, unknown> & { type?: string; content?: TipTapNode[]; text?: string; marks?: Array<{ type: string }>; attrs?: Record<string, unknown> }

function inlineFrom(node: TipTapNode): string {
  if (!node || typeof node !== "object") return ""
  if (typeof node.text === "string") return textMarks(node.text, Array.isArray(node.marks) ? node.marks : [])
  if (!Array.isArray(node.content)) return ""
  return node.content.map((item) => inlineFrom(item)).join("")
}

function blockFrom(node: TipTapNode, depth = 0): string[] {
  if (!node || typeof node !== "object") return []
  const type = typeof node.type === "string" ? node.type : ""
  if (type === "doc") {
    if (!Array.isArray(node.content)) return []
    return node.content.flatMap((item) => blockFrom(item, depth))
  }
  if (type === "heading") {
    const level = Math.max(1, Math.min(6, Number(node?.attrs?.level) || 1))
    return [`${"#".repeat(level)} ${inlineFrom(node)}`]
  }
  if (type === "paragraph") return [inlineFrom(node)]
  if (type === "blockquote") {
    return blockFrom({ type: "doc", content: Array.isArray(node.content) ? node.content : [] }, depth)
      .map((line) => `> ${line}`)
  }
  if (type === "codeBlock") {
    const lang = typeof node?.attrs?.language === "string" ? node.attrs.language : ""
    const body = inlineFrom(node)
    return [`\`\`\`${lang}`, body, "```"]
  }
  if (type === "horizontalRule") return ["---"]
  if (type === "bulletList") {
    const items = Array.isArray(node.content) ? node.content : []
    return items.flatMap((item: TipTapNode) => {
      const lines = blockFrom(item, depth + 1)
      if (!lines.length) return [`${"  ".repeat(depth)}- `]
      const [head, ...tail] = lines
      return [`${"  ".repeat(depth)}- ${head}`, ...tail.map((line) => `${"  ".repeat(depth + 1)}${line}`)]
    })
  }
  if (type === "orderedList") {
    const start = Number(node?.attrs?.start) || 1
    const items = Array.isArray(node.content) ? node.content : []
    return items.flatMap((item: TipTapNode, idx: number) => {
      const lines = blockFrom(item, depth + 1)
      const n = start + idx
      if (!lines.length) return [`${"  ".repeat(depth)}${n}. `]
      const [head, ...tail] = lines
      return [`${"  ".repeat(depth)}${n}. ${head}`, ...tail.map((line) => `${"  ".repeat(depth + 1)}${line}`)]
    })
  }
  if (type === "taskItem") {
    const checked = Boolean(node?.attrs?.checked)
    const rows: string[] = Array.isArray(node.content) ? node.content.flatMap((item) => blockFrom(item, depth + 1)) : []
    if (!rows.length) return [`- [${checked ? "x" : " "}] `]
    const [head, ...tail] = rows
    return [`- [${checked ? "x" : " "}] ${head}`, ...tail.map((line: string) => `  ${line}`)]
  }
  if (type === "taskList") {
    const items = Array.isArray(node.content) ? node.content : []
    return items.flatMap((item) => blockFrom(item, depth))
  }
  if (type === "listItem") {
    const lines = Array.isArray(node.content) ? node.content.flatMap((item) => blockFrom(item, depth + 1)) : []
    return lines
  }
  if (type === "image") {
    const alt = typeof node?.attrs?.alt === "string" ? node.attrs.alt : ""
    const src = typeof node?.attrs?.src === "string" ? node.attrs.src : ""
    const title = typeof node?.attrs?.title === "string" ? node.attrs.title : ""
    if (!src) return []
    if (!title) return [`![${alt}](${src})`]
    return [`![${alt}](${src} "${title}")`]
  }
  if (type === "table") {
    const rows = Array.isArray(node.content) ? node.content : []
    const matrix = rows.map((row: TipTapNode) =>
      Array.isArray(row?.content) ? row.content.map((cell: TipTapNode) => inlineFrom(cell).replace(/\s+/g, " ").trim()) : [],
    )
    const width = matrix.reduce((max: number, row: string[]) => Math.max(max, row.length), 0)
    if (!width) return []
    const head = (matrix[0] || []).concat(Array.from({ length: Math.max(0, width - (matrix[0] || []).length) }, () => ""))
    const separator = Array.from({ length: width }, () => "---")
    const body = matrix.slice(1).map((row: string[]) =>
      row.concat(Array.from({ length: Math.max(0, width - row.length) }, () => "")))
    const lines = [`| ${head.join(" | ")} |`, `| ${separator.join(" | ")} |`]
    body.forEach((row: string[]) => lines.push(`| ${row.join(" | ")} |`))
    return lines
  }
  if (type === "hardBreak") return ["  "]
  if (Array.isArray(node.content)) return node.content.flatMap((item) => blockFrom(item, depth))
  return []
}

export function markdownFromContent(content: string) {
  const parsed = parseContent(content)
  if (!parsed || typeof parsed !== "object") return { markdown: content, derived: false }
  const lines = blockFrom(parsed).filter((line, idx, all) => !(line === "" && all[idx - 1] === ""))
  return {
    markdown: lines.join("\n\n").trimEnd(),
    derived: true,
  }
}

function sameMarks(a: Array<Record<string, unknown>> | undefined, b: Array<Record<string, unknown>> | undefined) {
  return JSON.stringify(a || []) === JSON.stringify(b || [])
}

function pushText(
  out: Array<Record<string, unknown>>,
  text: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [],
) {
  if (!text) return
  const nextMarks = marks.map((mark) => (mark.attrs ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }))
  const prev = out[out.length - 1]
  if (prev?.type === "text" && sameMarks(prev.marks as Array<Record<string, unknown>> | undefined, nextMarks)) {
    prev.text = `${typeof prev.text === "string" ? prev.text : ""}${text}`
    return
  }
  out.push(nextMarks.length ? { type: "text", text, marks: nextMarks } : { type: "text", text })
}

function capture(match: RegExpExecArray, index: number) {
  return match[index] ?? ""
}

function parseInlineNodes(
  source: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let value = source
  while (value.length) {
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(value)
    if (image) {
      out.push({
        type: "image",
        attrs: {
          alt: image[1] || "",
          src: image[2] || "",
          title: image[3] || "",
        },
      })
      value = value.slice(image[0].length)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(value)
    if (link) {
      out.push(
        ...parseInlineNodes(capture(link, 1), [
          ...marks,
          { type: "link", attrs: { href: capture(link, 2), title: capture(link, 3) || null } },
        ]),
      )
      value = value.slice(link[0].length)
      continue
    }
    const code = /^`([^`\n]+)`/.exec(value)
    if (code) {
      pushText(out, capture(code, 1), [...marks, { type: "code" }])
      value = value.slice(code[0].length)
      continue
    }
    const strong = /^\*\*([\s\S]+?)\*\*/.exec(value)
    if (strong) {
      out.push(...parseInlineNodes(capture(strong, 1), [...marks, { type: "bold" }]))
      value = value.slice(strong[0].length)
      continue
    }
    const strike = /^~~([\s\S]+?)~~/.exec(value)
    if (strike) {
      out.push(...parseInlineNodes(capture(strike, 1), [...marks, { type: "strike" }]))
      value = value.slice(strike[0].length)
      continue
    }
    const highlight = /^==([\s\S]+?)==/.exec(value)
    if (highlight) {
      out.push(...parseInlineNodes(capture(highlight, 1), [...marks, { type: "highlight" }]))
      value = value.slice(highlight[0].length)
      continue
    }
    const underline = /^\+\+([\s\S]+?)\+\+/.exec(value)
    if (underline) {
      out.push(...parseInlineNodes(capture(underline, 1), [...marks, { type: "underline" }]))
      value = value.slice(underline[0].length)
      continue
    }
    const italicStar = /^\*([^*\n]+)\*/.exec(value)
    if (italicStar) {
      out.push(...parseInlineNodes(capture(italicStar, 1), [...marks, { type: "italic" }]))
      value = value.slice(italicStar[0].length)
      continue
    }
    const italicUnderscore = /^_([^_\n]+)_/.exec(value)
    if (italicUnderscore) {
      out.push(...parseInlineNodes(capture(italicUnderscore, 1), [...marks, { type: "italic" }]))
      value = value.slice(italicUnderscore[0].length)
      continue
    }
    const next = value.search(/[!`\[*~=_+]/)
    if (next <= 0) {
      pushText(out, value.slice(0, 1), marks)
      value = value.slice(1)
      continue
    }
    pushText(out, value.slice(0, next), marks)
    value = value.slice(next)
  }
  return out
}

function paragraphFromLines(lines: string[]) {
  const inline: Array<Record<string, unknown>> = []
  lines.forEach((line, idx) => {
    const hard = /\s{2}$/.test(line)
    const chunk = line.replace(/\s+$/g, "")
    inline.push(...parseInlineNodes(chunk))
    if (idx < lines.length - 1) {
      if (hard) inline.push({ type: "hardBreak" })
      else pushText(inline, " ")
    }
  })
  if (!inline.length) return { type: "paragraph", content: [] as Array<Record<string, unknown>> }
  if (inline.length === 1 && inline[0]?.type === "image") return inline[0]
  return { type: "paragraph", content: inline }
}

function splitTableLine(line: string) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return value.split("|").map((cell) => cell.trim())
}

function isTableDivider(line: string) {
  if (!line.includes("|")) return false
  const cells = splitTableLine(line)
  if (!cells.length) return false
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isBlockStart(line: string, next: string | undefined) {
  if (!line.trim()) return false
  if (/^\s*#{1,6}\s+/.test(line)) return true
  if (/^\s*```/.test(line)) return true
  if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) return true
  if (/^\s*>/.test(line)) return true
  if (/^\s*[-+*]\s+\[[ xX]\]\s+/.test(line)) return true
  if (/^\s*[-+*]\s+/.test(line)) return true
  if (/^\s*\d+[.)]\s+/.test(line)) return true
  if (line.includes("|") && next && isTableDivider(next)) return true
  return false
}

function lineAt(lines: string[], index: number) {
  return lines[index] ?? ""
}

export function markdownToDoc(markdown: string) {
  const source = markdown.replace(/^<!--\s*claxedo:[^\n]*-->\s*\n?/i, "").replace(/\r\n?/g, "\n")
  const lines = source.split("\n")
  const content: Array<Record<string, unknown>> = []
  let i = 0
  while (i < lines.length) {
    const line = lineAt(lines, i)
    if (!line.trim()) {
      i += 1
      continue
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: capture(heading, 1).length },
        content: parseInlineNodes(capture(heading, 2)),
      })
      i += 1
      continue
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      content.push({ type: "horizontalRule" })
      i += 1
      continue
    }
    const fence = /^\s*```([\w-]*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lineAt(lines, i))) {
        body.push(lineAt(lines, i))
        i += 1
      }
      if (i < lines.length && /^\s*```/.test(lineAt(lines, i))) i += 1
      const text = body.join("\n")
      content.push({
        type: "codeBlock",
        attrs: { language: capture(fence, 1) || null },
        content: text ? [{ type: "text", text }] : [],
      })
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lineAt(lines, i))) {
        quote.push(lineAt(lines, i).replace(/^\s*>\s?/, ""))
        i += 1
      }
      const inner = markdownToDoc(quote.join("\n"))
      content.push({ type: "blockquote", content: (inner.content as Array<Record<string, unknown>>) || [] })
      continue
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lineAt(lines, i + 1))) {
      const header = splitTableLine(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lineAt(lines, i).includes("|") && lineAt(lines, i).trim()) {
        rows.push(splitTableLine(lineAt(lines, i)))
        i += 1
      }
      const width = Math.max(header.length, ...rows.map((row) => row.length))
      const pad = (row: string[]) => row.concat(Array.from({ length: Math.max(0, width - row.length) }, () => ""))
      const tableRows = [
        {
          type: "tableRow",
          content: pad(header).map((cell) => ({
            type: "tableHeader",
            content: [{ type: "paragraph", content: parseInlineNodes(cell) }],
          })),
        },
        ...rows.map((row) => ({
          type: "tableRow",
          content: pad(row).map((cell) => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: parseInlineNodes(cell) }],
          })),
        })),
      ]
      content.push({ type: "table", content: tableRows })
      continue
    }
    const task = /^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length) {
        const match = /^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/.exec(lineAt(lines, i))
        if (!match) break
        items.push({
          type: "taskItem",
          attrs: { checked: capture(match, 1).toLowerCase() === "x" },
          content: [paragraphFromLines([capture(match, 2)])],
        })
        i += 1
      }
      content.push({ type: "taskList", content: items })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      const start = Number(capture(ordered, 1)) || 1
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length) {
        const match = /^\s*(\d+)[.)]\s+(.*)$/.exec(lineAt(lines, i))
        if (!match) break
        items.push({ type: "listItem", content: [paragraphFromLines([capture(match, 2)])] })
        i += 1
      }
      content.push({ type: "orderedList", attrs: { start }, content: items })
      continue
    }
    const bullet = /^\s*[-+*]\s+(.*)$/.exec(line)
    if (bullet) {
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length) {
        const match = /^\s*[-+*]\s+(.*)$/.exec(lineAt(lines, i))
        if (!match) break
        items.push({ type: "listItem", content: [paragraphFromLines([capture(match, 1)])] })
        i += 1
      }
      content.push({ type: "bulletList", content: items })
      continue
    }
    const para: string[] = []
    while (i < lines.length) {
      const current = lineAt(lines, i)
      if (!current.trim()) break
      if (isBlockStart(current, lineAt(lines, i + 1)) && para.length) break
      para.push(current)
      i += 1
      if (isBlockStart(lineAt(lines, i), lineAt(lines, i + 1)) && para.length) break
    }
    content.push(paragraphFromLines(para))
  }
  return { type: "doc", content }
}
