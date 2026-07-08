import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import * as rootApi from "./index"
import { createWorkspaceRuntimeClient } from "./client"
import { WorkspaceRuntimeRouteManifest, WorkspaceRuntimeRoutes } from "./routes/manifest"

const root = path.resolve(import.meta.dirname, "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string; default: string }>
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs", "api-manifest.json"), "utf8")) as {
  packageExports: string[]
  rootRuntimeExports: string[]
  routePrefixes: string[]
}

describe("workspace-runtime public API manifest", () => {
  test("package exports are explicit and complete", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([...manifest.packageExports].sort())
    for (const key of manifest.packageExports) {
      expect(pkg.exports[key]?.types).toMatch(/^\.\/dist\/.+\.d\.ts$/)
      expect(pkg.exports[key]?.import).toMatch(/^\.\/dist\/.+\.mjs$/)
      expect(pkg.exports[key]?.default).toBe(pkg.exports[key]?.import)
    }
  })

  test("root runtime exports exactly match the manifest", () => {
    expect(Object.keys(rootApi).sort()).toEqual([...manifest.rootRuntimeExports].sort())
  })

  test("route manifest exposes only neutral runtime routes", () => {
    expect(WorkspaceRuntimeRouteManifest.map((item) => item.path).sort()).toEqual(
      manifest.routePrefixes.sort(),
    )
    expect(Object.values(WorkspaceRuntimeRoutes).sort()).toEqual(manifest.routePrefixes.sort())
    expect(WorkspaceRuntimeRouteManifest.every((item) => item.path.startsWith("/api/wr/"))).toBe(true)
  })

  // The kit stays decision-free: hosts construct the OpenCode engine and
  // inject its handler via WorkspaceHostOptions.opencodeRequest. A direct
  // engine import here would hard-couple every host to the embedded engine.
  test("kit sources never import the opencode engine package", () => {
    const violations: string[] = []
    const specifier = /(?:from\s+|import\(\s*|require\(\s*)["'](opencode(?:\/[^"']*)?)["']/g
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
          const source = fs.readFileSync(full, "utf8")
          for (const match of source.matchAll(specifier)) {
            violations.push(`${path.relative(root, full)} imports "${match[1]}"`)
          }
        }
      }
    }
    walk(path.join(root, "src"))
    expect(violations).toEqual([])
  })

  test("typed client builds file and search requests through neutral runtime routes", async () => {
    const seen: string[] = []
    const client = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      fetch: ((input) => {
        seen.push(input.toString())
        return Promise.resolve(new Response("{}", { status: 200 }))
      }) as typeof fetch,
    })

    await client.files.metadata("src/index.ts")
    await client.files.list()
    await client.files.search("index")

    expect(seen.map((item) => new URL(item).pathname)).toEqual([
      "/api/wr/file",
      "/api/wr/file/all",
      "/api/wr/find/file",
    ])
  })
})
