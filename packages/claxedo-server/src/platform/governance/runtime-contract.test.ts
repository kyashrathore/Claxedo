import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

const root = path.resolve(import.meta.dirname, "../../../../..")
const dirs = [
  "packages/claxedo-server/src",
  "packages/workspace-runtime/src",
  "packages/claxedo-app/src",
  "packages/claxedo-desktop/src",
]
const banned = ["[\"bun\",", "from \"bun\"", "Bun.", "BUN_BE_BUN"]
const porousPackageImports = [
  { from: "packages/claxedo-server/src", pattern: /from\s+["'][^"']*workspace-runtime\/src(?:\/[^"']*)?["']/ },
  { from: "packages/workspace-runtime/src", pattern: /from\s+["'][^"']*claxedo-server\/src(?:\/[^"']*)?["']/ },
  { from: "packages/claxedo-app/src", pattern: /from\s+["'][^"']*(?:workspace-runtime|claxedo-server)\/src(?:\/[^"']*)?["']/ },
]

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
    if (entry.name.includes("fixture.")) continue
    out.push(next)
  }
  return out
}

describe("runtime contract", () => {
  test("runtime source directories stay Bun-free", () => {
    const hits = dirs.flatMap((dir) =>
      files(path.join(root, dir))
        .filter((file) => !file.startsWith(path.join(root, "packages/claxedo-app/src/architecture") + path.sep))
        .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return banned.filter((item) => text.includes(item)).map((item) => `${path.relative(root, file)} -> ${item}`)
      }),
    )

    expect(hits).toEqual([])
  })

  test("production packages do not import sibling package src internals", () => {
    const hits = porousPackageImports.flatMap((rule) =>
      files(path.join(root, rule.from)).flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return rule.pattern.test(text) ? [path.relative(root, file)] : []
      }),
    )

    expect(hits).toEqual([])
  })

  test("package type entries point at generated or source exports, not manual shadows", () => {
    expect(JSON.parse(fs.readFileSync(path.join(root, "packages/workspace-runtime/package.json"), "utf8")).types).toBe("./dist/index.d.ts")
    expect(JSON.parse(fs.readFileSync(path.join(root, "packages/claxedo-server/package.json"), "utf8")).types).toBe("./src/index.ts")
  })
})
