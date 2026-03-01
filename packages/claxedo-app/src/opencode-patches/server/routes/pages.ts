import { Hono } from "hono"
import { lazy } from "@/util/lazy"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { PageArenaRoutes } from "./pages-arena"

type Page = {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

type PageAiAction = "improve" | "fix" | "shorten" | "lengthen" | "summarize" | "continue" | "custom"

type PageAiBody = {
  action?: string
  text?: string
  context?: string
  instruction?: string
  model?: string
  page_id?: string
  pageId?: string
}

type OpencodePart = {
  type?: string
  text?: string
  ignored?: boolean
  state?: { status?: string; output?: unknown } | null
}

type OpencodeError = {
  name?: string
  message?: string
  data?: { message?: string; providerID?: string; modelID?: string }
}

type OpencodePromptResult = {
  info?: { id?: string; providerID?: string; modelID?: string; error?: OpencodeError | null }
  parts?: OpencodePart[]
}

type MarkdownMeta = {
  page_id?: string
  updated_at?: string
  doc_hash?: string
  md_export_hash?: string
  md_export_base_doc_hash?: string
  derived_markdown?: boolean
}

/** Resolve a writable base directory for pages data. Falls back to $HOME when Instance.directory is "/" (desktop sidecar with no workspace). */
function pagesBaseDir() {
  const dir = Instance.directory
  return dir && dir !== "/" ? dir : homedir()
}

const pageMirrorRoot = process.env.PAGES_FILE_ROOT || ".claxedo/pages"
const pageMdAutoImport = clean(process.env.PAGES_MD_AUTO_IMPORT || "1") !== "0"
const pageSessions = new Map<string, { id: string; updated_at: number }>()
const promptCache = new Map<string, { expires_at: number; value: { text: string; provider: string; model: string } }>()

const db = lazy(() => {
  // Use Instance.directory so the pages DB lives inside the workspace (persistent)
  // instead of process.cwd() which may be an ephemeral temp directory.
  const dataDir = process.env.CLAXEDO_DATA_DIR || path.join(pagesBaseDir(), ".claxedo")
  mkdirSync(dataDir, { recursive: true })
  const database = new Database(path.join(dataDir, "pages.db"))
  database.exec("PRAGMA journal_mode=WAL")
  database.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return database
})

function clean(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

function positive(value: string, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function listPages(): Page[] {
  return db().query("SELECT id, title, content, created_at, updated_at FROM pages ORDER BY updated_at DESC").all() as Page[]
}

function getPage(id: string): Page | undefined {
  return db().query("SELECT id, title, content, created_at, updated_at FROM pages WHERE id = ?").get(id) as Page | undefined
}

function createPage(title?: string, content?: string): Page {
  const page: Page = {
    id: generateId(),
    title: clean(title) || "Untitled",
    content: typeof content === "string" ? content : "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  db().query("INSERT INTO pages (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    page.id,
    page.title,
    page.content,
    page.created_at,
    page.updated_at,
  )
  return page
}

function updatePage(id: string, patch: { title?: string; content?: string }): Page | undefined {
  const existing = getPage(id)
  if (!existing) return undefined
  const next: Page = {
    ...existing,
    title: patch.title !== undefined ? patch.title : existing.title,
    content: patch.content !== undefined ? patch.content : existing.content,
    updated_at: new Date().toISOString(),
  }
  db().query("UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(
    next.title,
    next.content,
    next.updated_at,
    id,
  )
  return next
}

function deletePage(id: string): boolean {
  const result = db().query("DELETE FROM pages WHERE id = ?").run(id)
  return result.changes > 0
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function mirrorDir() {
  const root = path.isAbsolute(pageMirrorRoot) ? pageMirrorRoot : path.join(pagesBaseDir(), pageMirrorRoot)
  mkdirSync(root, { recursive: true })
  return root
}

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

function inlineFrom(node: any): string {
  if (!node || typeof node !== "object") return ""
  if (typeof node.text === "string") return textMarks(node.text, Array.isArray(node.marks) ? node.marks : [])
  if (!Array.isArray(node.content)) return ""
  return node.content.map((item: unknown) => inlineFrom(item)).join("")
}

function blockFrom(node: any, depth = 0): string[] {
  if (!node || typeof node !== "object") return []
  const type = typeof node.type === "string" ? node.type : ""
  if (type === "doc") {
    if (!Array.isArray(node.content)) return []
    return node.content.flatMap((item: unknown) => blockFrom(item, depth))
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
    return items.flatMap((item: any) => {
      const lines = blockFrom(item, depth + 1)
      if (!lines.length) return [`${"  ".repeat(depth)}- `]
      const [head, ...tail] = lines
      return [`${"  ".repeat(depth)}- ${head}`, ...tail.map((line) => `${"  ".repeat(depth + 1)}${line}`)]
    })
  }
  if (type === "orderedList") {
    const start = Number(node?.attrs?.start) || 1
    const items = Array.isArray(node.content) ? node.content : []
    return items.flatMap((item: any, idx: number) => {
      const lines = blockFrom(item, depth + 1)
      const n = start + idx
      if (!lines.length) return [`${"  ".repeat(depth)}${n}. `]
      const [head, ...tail] = lines
      return [`${"  ".repeat(depth)}${n}. ${head}`, ...tail.map((line) => `${"  ".repeat(depth + 1)}${line}`)]
    })
  }
  if (type === "taskItem") {
    const checked = Boolean(node?.attrs?.checked)
    const rows = Array.isArray(node.content) ? node.content.flatMap((item: unknown) => blockFrom(item, depth + 1)) : []
    if (!rows.length) return [`- [${checked ? "x" : " "}] `]
    const [head, ...tail] = rows
    return [`- [${checked ? "x" : " "}] ${head}`, ...tail.map((line) => `  ${line}`)]
  }
  if (type === "taskList") {
    const items = Array.isArray(node.content) ? node.content : []
    return items.flatMap((item: unknown) => blockFrom(item, depth))
  }
  if (type === "listItem") {
    const lines = Array.isArray(node.content) ? node.content.flatMap((item: unknown) => blockFrom(item, depth + 1)) : []
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
    const matrix = rows.map((row: any) =>
      Array.isArray(row?.content) ? row.content.map((cell: any) => inlineFrom(cell).replace(/\s+/g, " ").trim()) : [],
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
  if (Array.isArray(node.content)) return node.content.flatMap((item: unknown) => blockFrom(item, depth))
  return []
}

function markdownFromContent(content: string) {
  const parsed = parseContent(content)
  if (!parsed || typeof parsed !== "object") return { markdown: content, derived: false }
  const lines = blockFrom(parsed).filter((line, idx, all) => !(line === "" && all[idx - 1] === ""))
  return {
    markdown: lines.join("\n\n").trimEnd(),
    derived: true,
  }
}

function mirrorPaths(id: string) {
  const root = mirrorDir()
  return {
    json: path.join(root, `${id}.page.json`),
    markdown: path.join(root, `${id}.md`),
    meta: path.join(root, `${id}.md.meta.json`),
  }
}

function buildMirror(page: Page) {
  const parsed = parseContent(page.content)
  const exported = markdownFromContent(page.content)
  const json = {
    version: 1,
    id: page.id,
    title: page.title,
    created_at: page.created_at,
    updated_at: page.updated_at,
    content: page.content,
    doc: parsed && typeof parsed === "object" ? parsed : undefined,
  }
  const docHash = sha256(page.content)
  const provenance = `<!-- claxedo: page_id=${page.id} updated_at=${page.updated_at} doc_hash=${docHash} derived_markdown=${exported.derived ? "1" : "0"} -->`
  const markdownBody = exported.markdown || ""
  const markdown = markdownBody ? `${provenance}\n\n${markdownBody}\n` : `${provenance}\n`
  const mdHash = sha256(markdown)
  const meta = {
    page_id: page.id,
    updated_at: page.updated_at,
    doc_hash: docHash,
    md_export_hash: mdHash,
    md_export_base_doc_hash: docHash,
    derived_markdown: exported.derived,
  }
  return { json, markdown, meta }
}

function writeMirror(page: Page) {
  const paths = mirrorPaths(page.id)
  const next = buildMirror(page)
  writeFileSync(paths.json, JSON.stringify(next.json, null, 2))
  writeFileSync(paths.markdown, next.markdown)
  writeFileSync(paths.meta, JSON.stringify(next.meta, null, 2))
}

function removeMirror(id: string) {
  const paths = mirrorPaths(id)
  rmSync(paths.json, { force: true })
  rmSync(paths.markdown, { force: true })
  rmSync(paths.meta, { force: true })
}

function stripProvenance(markdown: string) {
  return markdown.replace(/^<!--\s*claxedo:[^\n]*-->\s*\n?/i, "")
}

function parseProvenance(markdown: string): MarkdownMeta {
  const match = /^\s*<!--\s*claxedo:\s*([^\n>]*)-->/i.exec(markdown)
  if (!match?.[1]) return {}
  const values = match[1].trim().split(/\s+/)
  const meta: MarkdownMeta = {}
  values.forEach((entry) => {
    const idx = entry.indexOf("=")
    if (idx < 1) return
    const key = entry.slice(0, idx).toLowerCase()
    const value = entry.slice(idx + 1)
    if (!value) return
    if (key === "page_id") meta.page_id = value
    if (key === "updated_at") meta.updated_at = value
    if (key === "doc_hash") meta.doc_hash = value
    if (key === "md_export_hash") meta.md_export_hash = value
    if (key === "md_export_base_doc_hash") meta.md_export_base_doc_hash = value
    if (key === "derived_markdown") meta.derived_markdown = value === "1" || value.toLowerCase() === "true"
  })
  return meta
}

function asMeta(value: unknown): MarkdownMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as MarkdownMeta
}

function readMirrorState(id: string) {
  const paths = mirrorPaths(id)
  if (!existsSync(paths.markdown)) return null
  const markdown = readFileSync(paths.markdown, "utf-8")
  const fileMeta = existsSync(paths.meta)
    ? asMeta(
        (() => {
          try {
            return JSON.parse(readFileSync(paths.meta, "utf-8"))
          } catch {
            return {}
          }
        })(),
      )
    : {}
  const meta = {
    ...parseProvenance(markdown),
    ...fileMeta,
  }
  return { paths, markdown, meta }
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
        ...parseInlineNodes(link[1], [
          ...marks,
          { type: "link", attrs: { href: link[2] || "", title: link[3] || null } },
        ]),
      )
      value = value.slice(link[0].length)
      continue
    }
    const code = /^`([^`\n]+)`/.exec(value)
    if (code) {
      pushText(out, code[1], [...marks, { type: "code" }])
      value = value.slice(code[0].length)
      continue
    }
    const strong = /^\*\*([\s\S]+?)\*\*/.exec(value)
    if (strong) {
      out.push(...parseInlineNodes(strong[1], [...marks, { type: "bold" }]))
      value = value.slice(strong[0].length)
      continue
    }
    const strike = /^~~([\s\S]+?)~~/.exec(value)
    if (strike) {
      out.push(...parseInlineNodes(strike[1], [...marks, { type: "strike" }]))
      value = value.slice(strike[0].length)
      continue
    }
    const highlight = /^==([\s\S]+?)==/.exec(value)
    if (highlight) {
      out.push(...parseInlineNodes(highlight[1], [...marks, { type: "highlight" }]))
      value = value.slice(highlight[0].length)
      continue
    }
    const underline = /^\+\+([\s\S]+?)\+\+/.exec(value)
    if (underline) {
      out.push(...parseInlineNodes(underline[1], [...marks, { type: "underline" }]))
      value = value.slice(underline[0].length)
      continue
    }
    const italicStar = /^\*([^*\n]+)\*/.exec(value)
    if (italicStar) {
      out.push(...parseInlineNodes(italicStar[1], [...marks, { type: "italic" }]))
      value = value.slice(italicStar[0].length)
      continue
    }
    const italicUnderscore = /^_([^_\n]+)_/.exec(value)
    if (italicUnderscore) {
      out.push(...parseInlineNodes(italicUnderscore[1], [...marks, { type: "italic" }]))
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

function markdownToDoc(markdown: string) {
  const source = stripProvenance(markdown).replace(/\r\n?/g, "\n")
  const lines = source.split("\n")
  const content: Array<Record<string, unknown>> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: parseInlineNodes(heading[2]),
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
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length && /^\s*```/.test(lines[i])) i += 1
      const text = body.join("\n")
      content.push({
        type: "codeBlock",
        attrs: { language: fence[1] || null },
        content: text ? [{ type: "text", text }] : [],
      })
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""))
        i += 1
      }
      const inner = markdownToDoc(quote.join("\n"))
      content.push({ type: "blockquote", content: (inner.content as Array<Record<string, unknown>>) || [] })
      continue
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitTableLine(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableLine(lines[i]))
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
        const match = /^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i])
        if (!match) break
        items.push({
          type: "taskItem",
          attrs: { checked: match[1].toLowerCase() === "x" },
          content: [paragraphFromLines([match[2]])],
        })
        i += 1
      }
      content.push({ type: "taskList", content: items })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      const start = Number(ordered[1]) || 1
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length) {
        const match = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i])
        if (!match) break
        items.push({ type: "listItem", content: [paragraphFromLines([match[2]])] })
        i += 1
      }
      content.push({ type: "orderedList", attrs: { start }, content: items })
      continue
    }
    const bullet = /^\s*[-+*]\s+(.*)$/.exec(line)
    if (bullet) {
      const items: Array<Record<string, unknown>> = []
      while (i < lines.length) {
        const match = /^\s*[-+*]\s+(.*)$/.exec(lines[i])
        if (!match) break
        items.push({ type: "listItem", content: [paragraphFromLines([match[1]])] })
        i += 1
      }
      content.push({ type: "bulletList", content: items })
      continue
    }
    const para: string[] = []
    while (i < lines.length) {
      if (!lines[i].trim()) break
      if (isBlockStart(lines[i], lines[i + 1]) && para.length) break
      para.push(lines[i])
      i += 1
      if (isBlockStart(lines[i] || "", lines[i + 1]) && para.length) break
    }
    content.push(paragraphFromLines(para))
  }
  return { type: "doc", content }
}

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const value = node as { text?: unknown; content?: unknown }
  if (typeof value.text === "string") return value.text
  if (!Array.isArray(value.content)) return ""
  return value.content.map((item) => nodeText(item)).join("")
}

function importTitle(doc: unknown) {
  if (!doc || typeof doc !== "object") return ""
  const content = (doc as { content?: unknown }).content
  if (!Array.isArray(content)) return ""
  const headings = content
    .filter((item) => !!item && typeof item === "object" && (item as { type?: unknown }).type === "heading")
    .map((item) => item as { attrs?: { level?: unknown } })
  if (!headings.length) return ""
  const pick = headings.find((item) => Number(item.attrs?.level) === 1) || headings[0]
  return clean(nodeText(pick).replace(/\s+/g, " "))
}

type MarkdownSync = {
  page: Page
  imported: boolean
  conflict: boolean
  base_hash?: string
  current_hash?: string
}

function importMarkdown(page: Page, markdown: string) {
  const doc = markdownToDoc(markdown)
  const next = JSON.stringify(doc)
  const current = clean(page.title).toLowerCase()
  const title = (current === "" || current === "untitled") ? importTitle(doc) : ""
  const patch = {
    content: next,
    ...(title ? { title } : {}),
  }
  if (next === page.content && (!title || title === page.title)) {
    writeMirror(page)
    return { page, imported: false }
  }
  const updated = updatePage(page.id, patch) || page
  writeMirror(updated)
  return { page: updated, imported: updated.content !== page.content || updated.title !== page.title }
}

function syncFromMirror(page: Page, force = false): MarkdownSync {
  const state = readMirrorState(page.id)
  if (!state) return { page, imported: false, conflict: false }
  const mdHash = sha256(state.markdown)
  const currentExport = buildMirror(page)
  if (clean(state.meta.md_export_hash) === mdHash) return { page, imported: false, conflict: false }
  if (sha256(currentExport.markdown) === mdHash) return { page, imported: false, conflict: false }
  const currentHash = sha256(page.content)
  const baseHash = clean(state.meta.md_export_base_doc_hash || state.meta.doc_hash)
  if (!force && baseHash && baseHash !== currentHash) {
    return {
      page,
      imported: false,
      conflict: true,
      base_hash: baseHash,
      current_hash: currentHash,
    }
  }
  const result = importMarkdown(page, state.markdown)
  return { page: result.page, imported: result.imported, conflict: false }
}

function generateId() {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function toAction(value: string): PageAiAction | null {
  if (
    value === "improve" ||
    value === "fix" ||
    value === "shorten" ||
    value === "lengthen" ||
    value === "summarize" ||
    value === "continue" ||
    value === "custom"
  ) {
    return value
  }
  return null
}

function aiPrompt(action: PageAiAction, text: string, context: string, instruction: string) {
  if (action === "continue") {
    return [
      "Continue this writing naturally in the same style.",
      "Return only the continuation text.",
      context ? `Context:\n${context}` : `Start from:\n${text}`,
    ].join("\n\n")
  }
  if (action === "summarize") {
    return [
      "Summarize this content concisely.",
      "Return only the summary text.",
      `Content:\n${text || context}`,
    ].join("\n\n")
  }
  if (action === "custom") {
    return [
      `Instruction: ${instruction}`,
      "Return only transformed text.",
      `Content:\n${text || context}`,
    ].join("\n\n")
  }
  const intent =
    action === "improve"
      ? "Improve clarity and flow."
      : action === "fix"
        ? "Fix grammar and spelling."
        : action === "shorten"
          ? "Make this shorter without losing meaning."
          : "Expand this with useful detail while preserving intent."
  return [intent, "Keep the same language and tone.", "Return only rewritten text.", `Text:\n${text}`].join("\n\n")
}

const pageAiAgent = clean(process.env.PAGES_AI_AGENT) || "build"
const pageAiDefaultModel = clean(process.env.PAGES_AI_MODEL) || "opencode/big-pickle"
const pageAiTimeoutMs = positive(clean(process.env.PAGES_AI_TIMEOUT_MS), 45_000)
const pageAiCacheTtlMs = positive(clean(process.env.PAGES_AI_CACHE_TTL_MS), 180_000)
const pageAiCacheMax = Math.max(16, positive(clean(process.env.PAGES_AI_CACHE_MAX), 200))
const pageAiSessionTtlMs = positive(clean(process.env.PAGES_AI_SESSION_TTL_MS), 6 * 60 * 60 * 1000)

const sessionKey = (body: PageAiBody) => clean(body.page_id || body.pageId) || "default"

const modelRef = (value: string) => {
  const source = clean(value) || pageAiDefaultModel
  if (!source) return undefined
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: source.slice(0, idx),
    modelID: source.slice(idx + 1),
  }
}

const apiPath = (pathname: string, directory: string) => {
  if (!directory) return pathname
  const join = pathname.includes("?") ? "&" : "?"
  return `${pathname}${join}directory=${encodeURIComponent(directory)}`
}

const extractText = (parts: OpencodePart[] | undefined) => {
  const text = (parts || [])
    .filter((part) => part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("")
    .trim()
  if (text) return text
  const toolText = (parts || [])
    .filter((part) => part.type === "tool" && part.state?.status === "completed")
    .map((part) => {
      const output = part.state?.output
      if (typeof output === "string") return output
      if (!output || typeof output !== "object") return ""
      const value = (output as { text?: unknown }).text
      return typeof value === "string" ? value : ""
    })
    .join("\n")
    .trim()
  if (toolText) return toolText
  return (parts || [])
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text || "")
    .join("")
    .trim()
}

const extractError = (result: OpencodePromptResult | null | undefined) => {
  const error = result?.info?.error
  if (!error) return ""
  const message = clean(error.data?.message || error.message)
  if (!message) return "OpenCode model request failed"
  const provider = clean(error.data?.providerID)
  if (!provider) return message
  return `${provider}: ${message}`
}

const pruneSessions = () => {
  const now = Date.now()
  for (const [key, value] of pageSessions.entries()) {
    if (now - value.updated_at > pageAiSessionTtlMs) pageSessions.delete(key)
  }
}

const cacheGet = (key: string) => {
  const entry = promptCache.get(key)
  if (!entry) return null
  if (entry.expires_at <= Date.now()) {
    promptCache.delete(key)
    return null
  }
  return entry.value
}

const cacheSet = (key: string, value: { text: string; provider: string; model: string }) => {
  promptCache.set(key, {
    expires_at: Date.now() + pageAiCacheTtlMs,
    value,
  })
  while (promptCache.size > pageAiCacheMax) {
    const first = promptCache.keys().next().value as string | undefined
    if (!first) break
    promptCache.delete(first)
  }
}

const opencodeFetch = async (origin: string, directory: string, pathname: string, init: RequestInit) => {
  const timeout = AbortSignal.timeout(pageAiTimeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const res = await fetch(`${origin}${apiPath(pathname, directory)}`, {
    ...init,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (res.ok) {
    if (res.status === 204) return null
    const text = await res.text()
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new Error("OpenCode returned invalid JSON")
    }
  }
  const body = await res.text().catch(() => "")
  const message = body || `OpenCode request failed (${res.status})`
  const error = new Error(message) as Error & { status?: number }
  error.status = res.status
  throw error
}

const createPageSession = async (origin: string, directory: string, key: string) => {
  const title = key === "default" ? "Page AI" : `Page AI • ${key}`
  const result = (await opencodeFetch(origin, directory, "/session", {
    method: "POST",
    body: JSON.stringify({ title }),
  })) as { id?: string } | null
  const id = clean(result?.id)
  if (!id) throw new Error("OpenCode did not return a session id")
  pageSessions.set(key, { id, updated_at: Date.now() })
  return id
}

const ensurePageSession = async (origin: string, directory: string, key: string) => {
  pruneSessions()
  const existing = pageSessions.get(key)
  if (!existing) return await createPageSession(origin, directory, key)
  pageSessions.set(key, { ...existing, updated_at: Date.now() })
  return existing.id
}

const runSessionPrompt = async (
  origin: string,
  directory: string,
  sessionID: string,
  system: string,
  prompt: string,
  model: { providerID: string; modelID: string } | undefined,
) => {
  const result = (await opencodeFetch(origin, directory, `/session/${encodeURIComponent(sessionID)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: pageAiAgent,
      system,
      model,
      parts: [{ type: "text", text: prompt }],
    }),
  })) as OpencodePromptResult | null

  const initialError = extractError(result)
  let text = extractText(result?.parts)
  if (!text && result?.info?.id) {
    const message = (await opencodeFetch(
      origin,
      directory,
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(result.info.id)}`,
      { method: "GET" },
    )) as OpencodePromptResult | null
    const messageError = extractError(message)
    if (messageError) throw new Error(messageError)
    text = extractText(message?.parts)
  }
  if (!text && initialError) throw new Error(initialError)
  if (!text) throw new Error("OpenCode returned empty output")

  const provider = clean(result?.info?.providerID) || model?.providerID || "opencode"
  const modelID = clean(result?.info?.modelID) || model?.modelID || clean(pageAiDefaultModel)
  return {
    text,
    provider,
    model: modelID ? `${provider}/${modelID}` : provider,
  }
}

const executeWithPageSession = async (
  origin: string,
  directory: string,
  key: string,
  system: string,
  prompt: string,
  model: { providerID: string; modelID: string } | undefined,
) => {
  const sessionID = await ensurePageSession(origin, directory, key)
  try {
    return await runSessionPrompt(origin, directory, sessionID, system, prompt, model)
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error
    pageSessions.delete(key)
    const fresh = await createPageSession(origin, directory, key)
    return await runSessionPrompt(origin, directory, fresh, system, prompt, model)
  }
}

async function aiGenerate(origin: string, directory: string, body: PageAiBody) {
  const action = toAction(clean(body.action || "improve"))
  if (!action) return { status: 400, data: { error: "Invalid AI action" } }

  const text = clean(body.text)
  const context = clean(body.context)
  const instruction = clean(body.instruction)
  if (action === "custom" && !instruction) return { status: 400, data: { error: "instruction is required for custom action" } }
  if (action !== "continue" && action !== "summarize" && action !== "custom" && !text) {
    return { status: 400, data: { error: "text is required" } }
  }

  const system =
    clean(process.env.PAGES_AI_SYSTEM_PROMPT) ||
    "You are a writing assistant for a rich text page editor. Return only final text with no labels."
  const prompt = aiPrompt(action, text, context, instruction)
  const pageKey = sessionKey(body)
  const model = modelRef(clean(body.model))
  const key = JSON.stringify([
    directory,
    pageKey,
    action,
    text,
    context,
    instruction,
    model?.providerID || "",
    model?.modelID || "",
    pageAiAgent,
  ])
  const cached = cacheGet(key)
  if (cached) return { status: 200, data: cached }

  try {
    const result = await executeWithPageSession(origin, directory, pageKey, system, prompt, model)
    cacheSet(key, result)
    return { status: 200, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenCode session request failed"
    return { status: 502, data: { error: message } }
  }
}

export const PagesRoutes = lazy(() =>
  new Hono()
    .get("/", (c) => {
      const pages = listPages()
      pages.forEach((page) => {
        const paths = mirrorPaths(page.id)
        if (!existsSync(paths.json) || !existsSync(paths.markdown) || !existsSync(paths.meta)) writeMirror(page)
      })
      return c.json(pages)
    })
    .post("/", async (c) => {
      const body = await c.req.json<{ title?: string; content?: string }>().catch(() => ({}))
      const page = createPage(body.title, body.content)
      writeMirror(page)
      return c.json(page, 201)
    })
    .post("/ai", async (c) => {
      const body = await c.req.json<PageAiBody>().catch(() => ({}))
      const origin = new URL(c.req.url).origin
      const directory = clean(c.req.query("directory") || c.req.header("x-opencode-directory"))
      const result = await aiGenerate(origin, directory, body)
      return c.json(result.data, result.status as 200 | 400 | 502)
    })
    .get("/:id/export/markdown", (c) => {
      const page = getPage(c.req.param("id"))
      if (!page) return c.json({ error: "Not found" }, 404)
      const mirror = buildMirror(page)
      if (clean(c.req.query("raw")) === "1") {
        c.header("Content-Type", "text/markdown; charset=utf-8")
        return c.body(mirror.markdown)
      }
      return c.json({
        id: page.id,
        title: page.title,
        markdown: mirror.markdown,
        meta: mirror.meta,
      })
    })
    .post("/:id/import/markdown", async (c) => {
      const body = await c.req.json<{ markdown?: string; force?: boolean }>().catch(() => ({}))
      const page = getPage(c.req.param("id"))
      if (!page) return c.json({ error: "Not found" }, 404)
      const markdown = typeof body.markdown === "string" ? body.markdown : ""
      if (!markdown.trim()) return c.json({ error: "markdown is required" }, 400)
      const force = Boolean(body.force)
      const meta = parseProvenance(markdown)
      const baseHash = clean(meta.md_export_base_doc_hash || meta.doc_hash)
      const currentHash = sha256(page.content)
      if (!force && baseHash && baseHash !== currentHash) {
        return c.json(
          {
            error: "Markdown import conflict",
            conflict: true,
            base_hash: baseHash,
            current_hash: currentHash,
          },
          409,
        )
      }
      const result = importMarkdown(page, markdown)
      return c.json({
        page: result.page,
        imported: result.imported,
        conflict: false,
      })
    })
    .post("/:id/sync/markdown", async (c) => {
      const body = await c.req.json<{ force?: boolean }>().catch(() => ({}))
      const page = getPage(c.req.param("id"))
      if (!page) return c.json({ error: "Not found" }, 404)
      const state = readMirrorState(page.id)
      if (!state) {
        writeMirror(page)
        return c.json({
          page,
          imported: false,
          conflict: false,
          initialized: true,
        })
      }
      const result = syncFromMirror(page, Boolean(body.force))
      if (result.conflict) return c.json(result, 409)
      return c.json(result)
    })
    .route("/:id/arena", PageArenaRoutes())
    .get("/:id", (c) => {
      const existing = getPage(c.req.param("id"))
      if (!existing) return c.json({ error: "Not found" }, 404)
      if (!pageMdAutoImport) {
        const paths = mirrorPaths(existing.id)
        if (!existsSync(paths.json) || !existsSync(paths.markdown) || !existsSync(paths.meta)) writeMirror(existing)
        return c.json(existing)
      }
      const synced = syncFromMirror(existing)
      if (!synced.conflict) return c.json(synced.page)
      // Conflict means the .md file was edited externally. Since every editor
      // save calls writeMirror() (which updates the export hash), a hash
      // mismatch on GET means the .md file is newer. Force-import it rather
      // than returning stale content with headers nobody acts on.
      const forced = syncFromMirror(existing, true)
      return c.json(forced.page)
    })
    .patch("/:id", async (c) => {
      const body = await c.req.json<{ title?: string; content?: string }>().catch(() => ({}))
      const page = updatePage(c.req.param("id"), body)
      if (!page) return c.json({ error: "Not found" }, 404)
      writeMirror(page)
      return c.json(page)
    })
    .delete("/:id", (c) => {
      const removed = deletePage(c.req.param("id"))
      if (!removed) return c.json({ error: "Not found" }, 404)
      removeMirror(c.req.param("id"))
      return c.json({ ok: true })
    }),
)
