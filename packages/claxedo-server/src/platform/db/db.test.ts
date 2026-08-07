import { afterEach, expect, test } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "./db"

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
