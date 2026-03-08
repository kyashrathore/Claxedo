/**
 * Tests for page status backend logic: status schema, CRUD, transitions,
 * and orphan reassignment.
 *
 * Tests the DB functions directly using bun:sqlite with a temp in-memory DB,
 * bypassing Hono route layer (which depends on upstream-only packages).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

// ── In-memory SQLite DB setup (mirrors pages.ts schema + migration) ───

type Page = {
  id: string
  title: string
  content: string
  status: string
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

const DEFAULT_STATUSES = [
  { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review", "in_progress"] },
  { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["in_progress", "draft"] },
  { id: "in_progress", name: "In Progress", color: "#3b82f6", position: 2, transitions: ["done", "in_review"] },
  { id: "done", name: "Done", color: "#22c55e", position: 3, transitions: ["archived", "in_progress"] },
  { id: "archived", name: "Archived", color: "#9ca3af", position: 4, transitions: ["draft"] },
]

let database: Database
let idCounter = 0

function initDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_statuses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6b7280',
      position INTEGER NOT NULL DEFAULT 0,
      transitions TEXT NOT NULL DEFAULT '[]'
    )
  `)
  // Seed defaults
  const insert = db.prepare("INSERT INTO page_statuses (id, name, color, position, transitions) VALUES (?, ?, ?, ?, ?)")
  for (const s of DEFAULT_STATUSES) {
    insert.run(s.id, s.name, s.color, s.position, JSON.stringify(s.transitions))
  }
  return db
}

// ── DB helper functions (mirrors pages.ts implementation) ─────────────

function listPages(): Page[] {
  return database.query("SELECT id, title, content, status, created_at, updated_at FROM pages ORDER BY updated_at DESC").all() as Page[]
}

function getPage(id: string): Page | undefined {
  return database.query("SELECT id, title, content, status, created_at, updated_at FROM pages WHERE id = ?").get(id) as Page | undefined
}

function createPage(title?: string, content?: string, status?: string): Page {
  idCounter++
  const page: Page = {
    id: `page_test_${idCounter}`,
    title: (title || "").trim() || "Untitled",
    content: typeof content === "string" ? content : "",
    status: (status || "").trim() || "draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  database.query("INSERT INTO pages (id, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    page.id, page.title, page.content, page.status, page.created_at, page.updated_at,
  )
  return page
}

function listStatuses(): PageStatusDef[] {
  return database.query("SELECT id, name, color, position, transitions FROM page_statuses ORDER BY position ASC").all() as PageStatusDef[]
}

function saveStatuses(statuses: Array<{ id: string; name: string; color: string; position: number; transitions: string[] }>): PageStatusDef[] {
  const ids = statuses.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate status IDs")
  for (const s of statuses) {
    for (const t of s.transitions) {
      if (!ids.includes(t)) throw new Error(`Transition target "${t}" does not exist`)
    }
  }
  const existing = listStatuses()
  const removedIds = existing.map((s) => s.id).filter((id) => !ids.includes(id))
  const fallbackStatus = statuses.length > 0 ? statuses.reduce((a, b) => (a.position < b.position ? a : b)).id : "draft"
  if (removedIds.length) {
    const placeholders = removedIds.map(() => "?").join(",")
    database.query(`UPDATE pages SET status = ? WHERE status IN (${placeholders})`).run(fallbackStatus, ...removedIds)
  }
  database.exec("DELETE FROM page_statuses")
  const insert = database.prepare("INSERT INTO page_statuses (id, name, color, position, transitions) VALUES (?, ?, ?, ?, ?)")
  for (const s of statuses) {
    insert.run(s.id, s.name, s.color, s.position, JSON.stringify(s.transitions))
  }
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
  database.query("UPDATE pages SET status = ?, updated_at = ? WHERE id = ?").run(targetStatus, new Date().toISOString(), pageId)
  return { page: getPage(pageId) }
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  database = initDb()
  idCounter = 0
})

describe("default status seeding", () => {
  test("seeds 5 default statuses", () => {
    const statuses = listStatuses()
    expect(statuses.length).toBe(5)
  })

  test("default statuses are ordered by position", () => {
    const statuses = listStatuses()
    const positions = statuses.map((s) => s.position)
    expect(positions).toEqual([0, 1, 2, 3, 4])
  })

  test("default statuses have correct IDs", () => {
    const statuses = listStatuses()
    expect(statuses.map((s) => s.id)).toEqual(["draft", "in_review", "in_progress", "done", "archived"])
  })

  test("transitions are stored as valid JSON arrays", () => {
    const statuses = listStatuses()
    for (const s of statuses) {
      const parsed = JSON.parse(s.transitions)
      expect(Array.isArray(parsed)).toBe(true)
    }
  })

  test("draft transitions are correct", () => {
    const statuses = listStatuses()
    const draft = statuses[0]
    expect(JSON.parse(draft.transitions)).toEqual(["in_review", "in_progress"])
  })
})

describe("page creation with status", () => {
  test("creates page with default draft status", () => {
    const page = createPage("Test Page")
    expect(page.status).toBe("draft")
  })

  test("creates page with explicit status", () => {
    const page = createPage("Test", "", "in_progress")
    expect(page.status).toBe("in_progress")
  })

  test("empty status string defaults to draft", () => {
    const page = createPage("Test", "", "")
    expect(page.status).toBe("draft")
  })

  test("list includes status field", () => {
    createPage("A", "", "draft")
    createPage("B", "", "in_review")
    const pages = listPages()
    expect(pages.length).toBe(2)
    for (const p of pages) {
      expect(typeof p.status).toBe("string")
      expect(p.status.length).toBeGreaterThan(0)
    }
  })

  test("get by id includes status field", () => {
    const created = createPage("Get Test", "", "done")
    const fetched = getPage(created.id)
    expect(fetched).toBeTruthy()
    expect(fetched!.status).toBe("done")
  })
})

describe("saveStatuses", () => {
  test("replaces all statuses", () => {
    const custom = [
      { id: "todo", name: "To Do", color: "#ef4444", position: 0, transitions: ["doing"] },
      { id: "doing", name: "Doing", color: "#3b82f6", position: 1, transitions: ["done"] },
      { id: "done", name: "Done", color: "#22c55e", position: 2, transitions: [] },
    ]
    const saved = saveStatuses(custom)
    expect(saved.length).toBe(3)
    expect(saved.map((s) => s.id)).toEqual(["todo", "doing", "done"])
  })

  test("persists changes", () => {
    saveStatuses([
      { id: "a", name: "A", color: "#000", position: 0, transitions: [] },
    ])
    const fetched = listStatuses()
    expect(fetched.length).toBe(1)
    expect(fetched[0].id).toBe("a")
  })

  test("throws on duplicate IDs", () => {
    expect(() => {
      saveStatuses([
        { id: "a", name: "A", color: "#000", position: 0, transitions: [] },
        { id: "a", name: "A2", color: "#111", position: 1, transitions: [] },
      ])
    }).toThrow("Duplicate")
  })

  test("throws on invalid transition target", () => {
    expect(() => {
      saveStatuses([
        { id: "x", name: "X", color: "#000", position: 0, transitions: ["nonexistent"] },
      ])
    }).toThrow("nonexistent")
  })

  test("reassigns orphaned pages when status is removed", () => {
    saveStatuses([
      { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["active"] },
      { id: "active", name: "Active", color: "#3b82f6", position: 1, transitions: ["draft"] },
    ])
    const page = createPage("Orphan Test", "", "active")
    expect(getPage(page.id)!.status).toBe("active")

    // Remove "active" → page should be reassigned to "draft" (lowest position)
    saveStatuses([
      { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: [] },
    ])
    expect(getPage(page.id)!.status).toBe("draft")
  })

  test("reassigns to lowest-position status when multiple removed", () => {
    saveStatuses([
      { id: "a", name: "A", color: "#000", position: 0, transitions: [] },
      { id: "b", name: "B", color: "#111", position: 1, transitions: [] },
      { id: "c", name: "C", color: "#222", position: 2, transitions: [] },
    ])
    createPage("P1", "", "b")
    createPage("P2", "", "c")

    // Keep only "a", remove "b" and "c"
    saveStatuses([
      { id: "a", name: "A", color: "#000", position: 0, transitions: [] },
    ])

    const pages = listPages()
    for (const p of pages) {
      expect(p.status).toBe("a")
    }
  })
})

describe("transitionPageStatus", () => {
  test("transitions page to valid target status", () => {
    const page = createPage("Test", "", "draft")
    const result = transitionPageStatus(page.id, "in_review")
    expect(result.error).toBeUndefined()
    expect(result.page!.status).toBe("in_review")
  })

  test("persists the transition", () => {
    const page = createPage("Test", "", "draft")
    transitionPageStatus(page.id, "in_review")
    expect(getPage(page.id)!.status).toBe("in_review")
  })

  test("rejects disallowed transition", () => {
    const page = createPage("Test", "", "draft")
    // draft can go to in_review or in_progress, not done
    const result = transitionPageStatus(page.id, "done")
    expect(result.error).toContain("not allowed")
    expect(result.status).toBe(422)
    // Page status unchanged
    expect(getPage(page.id)!.status).toBe("draft")
  })

  test("rejects nonexistent target status", () => {
    const page = createPage("Test", "", "draft")
    const result = transitionPageStatus(page.id, "imaginary")
    expect(result.error).toContain("does not exist")
    expect(result.status).toBe(422)
  })

  test("returns 404 for nonexistent page", () => {
    const result = transitionPageStatus("no-such-page", "draft")
    expect(result.error).toBe("Not found")
    expect(result.status).toBe(404)
  })

  test("multi-step transition chain", () => {
    const page = createPage("Chain", "", "draft")

    // draft → in_review (allowed)
    const r1 = transitionPageStatus(page.id, "in_review")
    expect(r1.page!.status).toBe("in_review")

    // in_review → in_progress (allowed)
    const r2 = transitionPageStatus(page.id, "in_progress")
    expect(r2.page!.status).toBe("in_progress")

    // in_progress → done (allowed)
    const r3 = transitionPageStatus(page.id, "done")
    expect(r3.page!.status).toBe("done")

    // done → archived (allowed)
    const r4 = transitionPageStatus(page.id, "archived")
    expect(r4.page!.status).toBe("archived")

    // archived → draft (allowed, full circle)
    const r5 = transitionPageStatus(page.id, "draft")
    expect(r5.page!.status).toBe("draft")
  })

  test("dead-end status blocks all transitions", () => {
    saveStatuses([
      { id: "open", name: "Open", color: "#000", position: 0, transitions: ["closed"] },
      { id: "closed", name: "Closed", color: "#111", position: 1, transitions: [] },
    ])
    const page = createPage("Dead End", "", "open")
    transitionPageStatus(page.id, "closed")

    // "closed" has no transitions → any target should fail
    const r1 = transitionPageStatus(page.id, "open")
    expect(r1.error).toContain("not allowed")
    const r2 = transitionPageStatus(page.id, "closed")
    expect(r2.error).toContain("not allowed")
  })

  test("updated_at is a valid ISO string after transition", () => {
    const page = createPage("Timestamp", "", "draft")
    const result = transitionPageStatus(page.id, "in_review")
    const ts = result.page!.updated_at
    expect(typeof ts).toBe("string")
    expect(new Date(ts).toISOString()).toBe(ts)
    expect(new Date(ts).getTime()).toBeGreaterThan(0)
  })
})

describe("status with custom config after saveStatuses", () => {
  test("transition respects custom statuses", () => {
    saveStatuses([
      { id: "backlog", name: "Backlog", color: "#6b7280", position: 0, transitions: ["ready"] },
      { id: "ready", name: "Ready", color: "#f59e0b", position: 1, transitions: ["backlog"] },
    ])
    const page = createPage("Custom", "", "backlog")
    const result = transitionPageStatus(page.id, "ready")
    expect(result.page!.status).toBe("ready")

    // Reverse transition allowed
    const r2 = transitionPageStatus(page.id, "backlog")
    expect(r2.page!.status).toBe("backlog")
  })
})
