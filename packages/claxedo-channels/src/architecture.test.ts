import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return full
  })
}

describe("channels architecture", () => {
  test("keeps core transport-agnostic", () => {
    const core = path.resolve(import.meta.dirname, "core")
    const offenders = walk(core)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => {
        const source = fs.readFileSync(file, "utf8")
        return source.includes("chat-sdk")
          || source.includes("@chat-adapter")
          || source.includes(" from \"chat\"")
          || source.includes("../transport/")
          ? [path.relative(import.meta.dirname, file)]
          : []
      })

    expect(offenders).toEqual([])
  })
})
