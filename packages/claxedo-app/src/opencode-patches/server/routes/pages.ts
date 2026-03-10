import { Hono } from "hono"
import { lazy } from "@/util/lazy"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Instance } from "@/project/instance"
import { PageArenaRoutes, clean, id } from "./pages-arena"
import { ClaxedoDB, eq, and, desc, inArray } from "@/storage/claxedo-db"
import { ClaxedoPageTable, ClaxedoPageStatusTable } from "@/storage/claxedo/schema"
import { migratePages } from "@/storage/claxedo-migrate-legacy"

type Page = {
  id: string
  title: string
  content: string
  status: string
  session_id: string | null
  file_path: string | null
  directory: string | null
  created_at: string
  updated_at: string
}

type PageStatusDef = {
  id: string
  name: string
  color: string
  position: number
  transitions: string
}

const DEFAULT_STATUSES: Array<{ id: string; name: string; color: string; position: number; transitions: string[] }> = [
  { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review", "in_progress"] },
  { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["in_progress", "draft"] },
  { id: "in_progress", name: "In Progress", color: "#3b82f6", position: 2, transitions: ["done", "in_review"] },
  { id: "done", name: "Done", color: "#22c55e", position: 3, transitions: ["archived", "in_progress"] },
  { id: "archived", name: "Archived", color: "#9ca3af", position: 4, transitions: ["draft"] },
]

function projectId() {
  return Instance.project.id
}

const seededProjects = new Set<string>()

function ensureProject() {
  const pid = projectId()
  migratePages(pid)
  seedDefaultStatuses(pid)
}

function seedDefaultStatuses(pid: string) {
  if (seededProjects.has(pid)) return

  const count = ClaxedoDB.use((db) =>
    db
      .select({ id: ClaxedoPageStatusTable.id })
      .from(ClaxedoPageStatusTable)
      .where(eq(ClaxedoPageStatusTable.project_id, pid))
      .limit(1)
      .all(),
  )
  if (count.length > 0) {
    seededProjects.add(pid)
    return
  }

  ClaxedoDB.use((db) => {
    for (const s of DEFAULT_STATUSES) {
      db.insert(ClaxedoPageStatusTable)
        .values({
          id: s.id,
          project_id: pid,
          name: s.name,
          color: s.color,
          position: s.position,
          transitions: JSON.stringify(s.transitions),
        })
        .run()
    }
  })
  seededProjects.add(pid)
}

// ── File-backed page helpers ──

/** Resolve the absolute path for a file-backed page. */
function resolveFilePath(page: { file_path: string | null; directory: string | null }): string | null {
  if (!page.file_path) return null
  if (path.isAbsolute(page.file_path)) return page.file_path
  if (!page.directory) return null
  return path.resolve(page.directory, page.file_path)
}

/** Read markdown from a file-backed page and convert to doc JSON. */
function readFileContent(page: { file_path: string | null; directory: string | null }): string {
  const fullPath = resolveFilePath(page)
  if (!fullPath) return ""
  try {
    const markdown = readFileSync(fullPath, "utf-8")
    const doc = markdownToDoc(markdown)
    return JSON.stringify(doc)
  } catch {
    return ""
  }
}

/** Write doc JSON content back to the backing markdown file. */
function writeFileContent(page: { file_path: string | null; directory: string | null }, content: string) {
  const fullPath = resolveFilePath(page)
  if (!fullPath) return
  const { markdown } = markdownFromContent(content)
  writeFileSync(fullPath, markdown + "\n")
}

// ── CRUD ──

function listPages(): Page[] {
  ensureProject()
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(eq(ClaxedoPageTable.project_id, projectId()))
      .orderBy(desc(ClaxedoPageTable.updated_at))
      .all(),
  )
}

function getPage(id: string): Page | undefined {
  ensureProject()
  const row = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.id, id), eq(ClaxedoPageTable.project_id, projectId())))
      .get(),
  )
  if (!row) return undefined
  // For file-backed pages, read content from the file
  if (row.file_path) {
    return { ...row, content: readFileContent(row) }
  }
  return row
}

function createPage(title?: string, opts?: { content?: string; status?: string; file_path?: string; directory?: string }): Page {
  ensureProject()
  const page: Page & { project_id: string } = {
    id: id("page"),
    project_id: projectId(),
    title: clean(title) || "Untitled",
    content: opts?.file_path ? "" : (opts?.content ?? ""),
    status: clean(opts?.status) || "draft",
    session_id: null,
    file_path: opts?.file_path || null,
    directory: opts?.directory || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  ClaxedoDB.use((db) => db.insert(ClaxedoPageTable).values(page).run())
  // For file-backed pages, return with file content
  if (page.file_path) {
    return { ...page, content: readFileContent(page) }
  }
  return page
}

function listStatuses(): PageStatusDef[] {
  ensureProject()
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageStatusTable)
      .where(eq(ClaxedoPageStatusTable.project_id, projectId()))
      .orderBy(ClaxedoPageStatusTable.position)
      .all(),
  )
}

function saveStatuses(statuses: Array<{ id: string; name: string; color: string; position: number; transitions: string[] }>): PageStatusDef[] {
  ensureProject()
  const ids = statuses.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate status IDs")
  for (const s of statuses) {
    for (const t of s.transitions) {
      if (!ids.includes(t)) throw new Error(`Transition target "${t}" does not exist`)
    }
  }

  const pid = projectId()

  const existing = listStatuses()
  const removedIds = existing.map((s) => s.id).filter((id) => !ids.includes(id))
  const fallbackStatus = statuses.length > 0 ? statuses.reduce((a, b) => (a.position < b.position ? a : b)).id : "draft"

  ClaxedoDB.transaction((db) => {
    if (removedIds.length) {
      db.update(ClaxedoPageTable)
        .set({ status: fallbackStatus, updated_at: new Date().toISOString() })
        .where(
          and(
            eq(ClaxedoPageTable.project_id, pid),
            inArray(ClaxedoPageTable.status, removedIds),
          ),
        )
        .run()
    }

    db.delete(ClaxedoPageStatusTable).where(eq(ClaxedoPageStatusTable.project_id, pid)).run()

    for (const s of statuses) {
      db.insert(ClaxedoPageStatusTable)
        .values({
          id: s.id,
          project_id: pid,
          name: s.name,
          color: s.color,
          position: s.position,
          transitions: JSON.stringify(s.transitions),
        })
        .run()
    }
  })

  return listStatuses()
}

function transitionPageStatus(pageId: string, targetStatus: string): { page?: Page; error?: string; status?: number } {
  const page = getPage(pageId)
  if (!page) return { error: "Not found", status: 404 }

  const statuses = listStatuses()
  const target = statuses.find((s) => s.id === targetStatus)
  if (!target) return { error: `Status "${targetStatus}" does not exist`, status: 422 }

  const current = statuses.find((s) => s.id === page.status)
  if (current) {
    const allowed = JSON.parse(current.transitions) as string[]
    if (!allowed.includes(targetStatus)) {
      return { error: `Transition from "${page.status}" to "${targetStatus}" is not allowed`, status: 422 }
    }
  }

  const now = new Date().toISOString()
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoPageTable)
      .set({ status: targetStatus, updated_at: now })
      .where(and(eq(ClaxedoPageTable.id, pageId), eq(ClaxedoPageTable.project_id, projectId())))
      .run(),
  )
  return { page: { ...page, status: targetStatus, updated_at: now } }
}

function getPageRow(id: string) {
  ensureProject()
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.id, id), eq(ClaxedoPageTable.project_id, projectId())))
      .get(),
  )
}

function updatePage(id: string, patch: { title?: string; content?: string }): Page | undefined {
  // Use raw DB row to avoid unnecessary file I/O from getPage()
  const row = getPageRow(id)
  if (!row) return undefined

  const now = new Date().toISOString()

  if (row.file_path) {
    // File-backed: write content to file, only store metadata in DB
    if (patch.content !== undefined) {
      writeFileContent(row, patch.content)
    }
    const dbPatch: Record<string, string> = { updated_at: now }
    if (patch.title !== undefined) dbPatch.title = patch.title
    ClaxedoDB.use((db) =>
      db
        .update(ClaxedoPageTable)
        .set(dbPatch)
        .where(and(eq(ClaxedoPageTable.id, id), eq(ClaxedoPageTable.project_id, projectId())))
        .run(),
    )
    return {
      ...row,
      title: patch.title !== undefined ? patch.title : row.title,
      content: patch.content !== undefined ? patch.content : readFileContent(row),
      updated_at: now,
    }
  }

  // DB-backed: store everything in DB
  const next: Page = {
    ...row,
    title: patch.title !== undefined ? patch.title : row.title,
    content: patch.content !== undefined ? patch.content : row.content,
    updated_at: now,
  }
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoPageTable)
      .set({ title: next.title, content: next.content, updated_at: next.updated_at })
      .where(and(eq(ClaxedoPageTable.id, id), eq(ClaxedoPageTable.project_id, projectId())))
      .run(),
  )
  return next
}

function deletePage(id: string): boolean {
  const result = ClaxedoDB.use((db) =>
    db
      .delete(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.id, id), eq(ClaxedoPageTable.project_id, projectId())))
      .run(),
  )
  return result.changes > 0
}

// ── Markdown ↔ Doc conversion ──

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
  const source = markdown.replace(/^<!--\s*claxedo:[^\n]*-->\s*\n?/i, "").replace(/\r\n?/g, "\n")
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

// ── Routes ──

export const PagesRoutes = lazy(() =>
  new Hono()
    .get("/statuses", (c) => {
      const statuses = listStatuses().map((s) => ({
        ...s,
        transitions: JSON.parse(s.transitions) as string[],
      }))
      return c.json(statuses)
    })
    .put("/statuses", async (c) => {
      const body = await c.req.json<Array<{ id: string; name: string; color: string; position: number; transitions: string[] }>>().catch(() => [])
      if (!Array.isArray(body) || body.length === 0) return c.json({ error: "Expected non-empty array of statuses" }, 400)
      try {
        const saved = saveStatuses(body).map((s) => ({
          ...s,
          transitions: JSON.parse(s.transitions) as string[],
        }))
        return c.json(saved)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Invalid statuses" }, 422)
      }
    })
    .get("/by-file", (c) => {
      const filePath = clean(c.req.query("file_path"))
      const directory = clean(c.req.query("directory"))
      if (!filePath || !directory) return c.json(null)
      ensureProject()
      const row = ClaxedoDB.use((db) =>
        db
          .select()
          .from(ClaxedoPageTable)
          .where(
            and(
              eq(ClaxedoPageTable.project_id, projectId()),
              eq(ClaxedoPageTable.file_path, filePath),
              eq(ClaxedoPageTable.directory, directory),
            ),
          )
          .get(),
      )
      if (!row) return c.json(null)
      if (row.file_path) return c.json({ ...row, content: readFileContent(row) })
      return c.json(row)
    })
    .get("/", (c) => {
      return c.json(listPages())
    })
    .post("/", async (c) => {
      const body = await c.req.json<{ title?: string; content?: string; status?: string; file_path?: string; directory?: string }>().catch(() => ({}))
      const page = createPage(body.title, {
        content: body.content,
        status: body.status,
        file_path: body.file_path,
        directory: body.directory,
      })
      return c.json(page, 201)
    })
    .patch("/:id/session", async (c) => {
      const body = await c.req.json<{ session_id?: string | null }>().catch(() => ({}))
      const page = getPage(c.req.param("id"))
      if (!page) return c.json({ error: "Not found" }, 404)
      const sessionId = body.session_id !== undefined ? (body.session_id || null) : null
      ClaxedoDB.use((db) =>
        db
          .update(ClaxedoPageTable)
          .set({ session_id: sessionId })
          .where(and(eq(ClaxedoPageTable.id, page.id), eq(ClaxedoPageTable.project_id, projectId())))
          .run(),
      )
      return c.json(getPage(c.req.param("id")))
    })
    .post("/:id/status", async (c) => {
      const body = await c.req.json<{ status?: string }>().catch(() => ({}))
      const target = clean(body.status)
      if (!target) return c.json({ error: "status is required" }, 400)
      const result = transitionPageStatus(c.req.param("id"), target)
      if (result.error) return c.json({ error: result.error }, (result.status ?? 422) as 404 | 422)
      return c.json(result.page)
    })
    .route("/:id/arena", PageArenaRoutes())
    .get("/:id", (c) => {
      const page = getPage(c.req.param("id"))
      if (!page) return c.json({ error: "Not found" }, 404)
      return c.json(page)
    })
    .patch("/:id", async (c) => {
      const body = await c.req.json<{ title?: string; content?: string }>().catch(() => ({}))
      const page = updatePage(c.req.param("id"), body)
      if (!page) return c.json({ error: "Not found" }, 404)
      return c.json(page)
    })
    .delete("/:id", (c) => {
      const removed = deletePage(c.req.param("id"))
      if (!removed) return c.json({ error: "Not found" }, 404)
      return c.json({ ok: true })
    }),
)
