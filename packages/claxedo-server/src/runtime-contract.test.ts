import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dirname, "../../..")
const dirs = [
  "packages/claxedo-server/src",
  "packages/workspace-runtime/src",
  "packages/claxedo-app/src",
  "packages/claxedo-desktop/src",
]
const banned = ["[\"bun\",", "from \"bun\"", "Bun.", "BUN_BE_BUN"]

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...files(next))
      continue
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue
    if (entry.name.includes(".test.") || entry.name.includes(".vitest.")) continue
    out.push(next)
  }
  return out
}

describe("runtime contract", () => {
  test("runtime source directories stay Bun-free", () => {
    const hits = dirs.flatMap((dir) =>
      files(path.join(root, dir)).flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return banned.filter((item) => text.includes(item)).map((item) => `${path.relative(root, file)} -> ${item}`)
      }),
    )

    expect(hits).toEqual([])
  })
})
