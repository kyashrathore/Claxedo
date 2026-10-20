import { afterEach, expect, test, vi } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// Through the product wrapper; the suite's setup names the journals, as a
// composition root does.
import { ClaxedoDB } from "./index"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const root = mkdtempSync(path.join(tmpdir(), "claxedo-db-first-run-"))

afterEach(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  // Retried for Windows: the just-closed database file stays briefly locked.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test("creates a fresh data directory before opening claxedo.db", () => {
  const data = path.join(root, "fresh", "profile")
  process.env.CLAXEDO_DATA_DIR = data

  expect(existsSync(data)).toBe(false)
  ClaxedoDB.raw()
  expect(existsSync(path.join(data, "claxedo.db"))).toBe(true)
})

test("applies the journals the composition named, so a fresh profile has its tables", () => {
  process.env.CLAXEDO_DATA_DIR = path.join(root, "with-schema")

  const tables = (ClaxedoDB.raw()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]).map((row) => row.name)

  expect(tables).toContain("__claxedo_migrations")
  expect(tables.length).toBeGreaterThan(1)
})

test("refuses to open a database whose migration journal was never named", async () => {
  process.env.CLAXEDO_DATA_DIR = path.join(root, "unconfigured")
  // A fresh module graph: only a composition names the journals, so the
  // engine imported alone has none.
  vi.resetModules()
  const engine = await import("@claxedo/server-core/platform/db/db")

  expect(() => engine.ClaxedoDB.raw()).toThrow(/before its migration journals were configured/)
})
