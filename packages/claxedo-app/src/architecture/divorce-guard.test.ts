/**
 * Divorce guard (plan 006): claxedo-app must never re-couple to upstream
 * `@opencode-ai/app` (packages/app). The full upstream src was vendored into
 * this package and `@/` resolves to our own src — keep it that way.
 *
 * Allowed and unrelated: `@opencode-ai/app-shared` (an internal alias for
 * ./src/extensions) and the `@opencode-ai/ui` dependency (kept by design).
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

const UPSTREAM_PKG = "@opencode-ai/app"

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return []
      return listSourceFiles(file)
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return []
    return [file]
  })
}

describe("upstream divorce guard", () => {
  test("configs no longer resolve anything against packages/app/src", () => {
    for (const config of ["vite.cloud.config.ts", "tsconfig.json", "vitest.config.ts"]) {
      const text = readFileSync(path.join(appRoot, config), "utf8")
      expect(text).not.toContain("../app/src")
    }
  })

  test("package.json declares no @opencode-ai/app dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | unknown
    >
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = (pkg[section] ?? {}) as Record<string, string>
      const offenders = Object.keys(deps).filter((name) => name === UPSTREAM_PKG)
      expect(offenders).toEqual([])
    }
  })

  test("no source file imports from @opencode-ai/app", () => {
    // Matches `from "@opencode-ai/app"`, `from "@opencode-ai/app/x"`,
    // `import("@opencode-ai/app")`, and bare `import "@opencode-ai/app"`,
    // but NOT `@opencode-ai/app-shared` (different, internal alias).
    const importPattern =
      /(?:from\s*|import\s*\(\s*|import\s+)["']@opencode-ai\/app(?:\/[^"']*)?["']/g
    const guardFile = path.join(srcRoot, "architecture", "divorce-guard.test.ts")
    const offenders: string[] = []
    for (const file of listSourceFiles(srcRoot)) {
      if (file === guardFile) continue
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(importPattern)) {
        offenders.push(`${path.relative(srcRoot, file)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("no source file reaches into packages/app via a relative path", () => {
    // 007 Tier E: the last live relative imports (`../../../app/src/...`) were
    // vendored in-repo. Guard the relative form too, not just the package name,
    // so re-coupling to packages/app is a mechanical failure either way.
    // Excludes `.test.ts` files, which legitimately reference the path as a
    // string when auditing/asserting the boundary.
    const relativePattern = /(?:from\s*|import\s*\(\s*)["'](?:\.\.\/)+app\/src\/[^"']*["']/g
    const offenders: string[] = []
    for (const file of listSourceFiles(srcRoot)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(relativePattern)) {
        offenders.push(`${path.relative(srcRoot, file)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
