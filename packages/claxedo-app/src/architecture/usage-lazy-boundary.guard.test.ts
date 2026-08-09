import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { shortestForbiddenImportChain } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("usage lazy boundary", () => {
  test("keeps the page-scale Usage dashboard out of the eager app shell", () => {
    const source = readFileSync(path.join(appRoot, "src/app/app-shell-actions.ts"), "utf8")
    const dialogBarrel = readFileSync(path.join(appRoot, "src/app/dialogs/index.ts"), "utf8")

    expect(source).not.toMatch(/import\s+\{\s*DialogUsage\s*\}\s+from\s+["']\.\/dialogs\/usage["']/)
    expect(source).toContain('await import("./dialogs/usage")')
    expect(dialogBarrel).not.toContain("DialogUsage")

    for (const entry of ["app/entry/main.tsx", "app/entry/local.tsx", "app/entry/index.tsx"]) {
      const breach = shortestForbiddenImportChain({
        appRoot,
        entry,
        includeDynamic: false,
        isForbidden: ({ module }) =>
          module === "app/dialogs/usage.tsx" || module?.startsWith("features/usage/") === true,
      })
      expect(breach).toBeNull()
    }
  })
})
