/**
 * Pages SQLite database — CRUD for rich text page documents
 */
import { Database } from "bun:sqlite"
import { lazy } from "../lib/lazy.ts"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

export type Page = {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

const dataDir = process.env.CLAXEDO_DATA_DIR || join(process.cwd(), "data")

const db = lazy(() => {
  mkdirSync(dataDir, { recursive: true })
  const database = new Database(join(dataDir, "pages.db"))
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

function generateId(): string {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export function listPages(): Page[] {
  return db().query("SELECT * FROM pages ORDER BY updated_at DESC").all() as Page[]
}

export function getPage(id: string): Page | undefined {
  return db().query("SELECT * FROM pages WHERE id = ?").get(id) as Page | undefined
}

export function createPage(title?: string, content?: string): Page {
  const page: Page = {
    id: generateId(),
    title: title || "Untitled",
    content: content || "",
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

export function updatePage(id: string, patch: Partial<Pick<Page, "title" | "content">>): Page | undefined {
  const existing = getPage(id)
  if (!existing) return undefined

  const title = patch.title ?? existing.title
  const content = patch.content ?? existing.content
  const updated_at = new Date().toISOString()

  db().query("UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(title, content, updated_at, id)
  return { ...existing, title, content, updated_at }
}

export function deletePage(id: string): boolean {
  const result = db().query("DELETE FROM pages WHERE id = ?").run(id)
  return result.changes > 0
}
