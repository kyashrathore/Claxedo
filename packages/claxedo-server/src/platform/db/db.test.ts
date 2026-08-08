import { afterEach, expect, test, vi } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// Through the product wrapper, which names this product's migration journal.
import { ClaxedoDB } from "./index"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const root = mkdtempSync(path.join(tmpdir(), "claxedo-db-first-run-"))

afterEach(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

test("creates a fresh data directory before opening claxedo.db", () => {
  const data = path.join(root, "fresh", "profile")
  process.env.CLAXEDO_DATA_DIR = data

  expect(existsSync(data)).toBe(false)
  ClaxedoDB.raw()
  expect(existsSync(path.join(data, "claxedo.db"))).toBe(true)
})

test("applies this product's migration journal, so a fresh profile has its tables", () => {
  // The failure this guards is silent: an unconfigured journal used to mean
  // zero migrations and a working handle to a file with no tables, so every
  // query failed later, somewhere else, for a reason its stack trace did not
  // name. Assert the schema is actually there.
  process.env.CLAXEDO_DATA_DIR = path.join(root, "with-schema")

  const tables = (ClaxedoDB.raw()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]).map((row) => row.name)

  expect(tables).toContain("__claxedo_migrations")
  expect(tables.length).toBeGreaterThan(1)
})

test("refuses to open a database whose migration journal was never named", async () => {
  process.env.CLAXEDO_DATA_DIR = path.join(root, "unconfigured")
  // A fresh module graph: the product wrapper is what performs the
  // configuration, so importing the engine alone leaves it unset.
  vi.resetModules()
  const engine = await import("@claxedo/server-core/platform/db/db")

  expect(() => engine.ClaxedoDB.raw()).toThrow(/migration journal was configured/)
})
