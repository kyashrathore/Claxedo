import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("Convex test cleanup safety", () => {
  test("never deletes a cwd-relative Convex source directory", () => {
    const unsafeCleanup = /rmSync\(\s*path\.resolve\(\s*process\.cwd\(\)\s*,\s*["']convex["']\s*\)/
    const files = fs.readdirSync(import.meta.dirname)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => ({ file, source: fs.readFileSync(path.join(import.meta.dirname, file), "utf8") }))

    expect(files.filter((file) => unsafeCleanup.test(file.source)).map((file) => file.file)).toEqual([])
  })
})
