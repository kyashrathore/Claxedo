import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Worker import-graph guard.
 *
 * Statically walks the transitive import graph from the Cloudflare Worker
 * entrypoint (`worker.ts`) and fails if any local-only module or Node-only
 * dependency enters the graph. This is the mechanical protection the goal
 * requires: a reviewer should not have to eyeball the whole tree to know
 * whether `fs`, `better-sqlite3`, `@hono/node-server`, the workspace store, the
 * runtime supervisor, etc. slipped back into the Worker bundle.
 *
 * `import type` / `export type` statements are erased by the bundler, so they
 * are NOT followed (matching real bundle behaviour). Inline `import { type X,
 * value }` IS followed, because the module still loads at runtime for `value`.
 * Dynamic `import("...")` IS followed, because the bundler still emits the chunk.
 */

const SRC = path.resolve(import.meta.dirname)
const ENTRYPOINTS = ["worker.ts", "hosted-app.ts"]

// Node-only / heavy packages that must never reach the Worker bundle.
const FORBIDDEN_BARE = [
  "@hono/node-server",
  "@hono/node-ws",
  "@claxedo/channels",
  "@claxedo/workspace-runtime",
  "better-sqlite3",
  "node-pty",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "fs",
  "fs/promises",
  "posthog-node",
  "modal",
  "tokentracker-cli",
  "tokentracker-cli/src/lib/usage-limits.js",
  "@vercel/sandbox",
]

// Local-only source modules that must never reach the Worker bundle.
const FORBIDDEN_LOCAL = [
  "workspace-store",
  "workspace-supervisor",
  "embedded-workspace-runtime",
  "user-hosted-tunnel",
  "credentials/store",
  "credentials/registry",
  "credentials/local",
  "cloud/sandbox",
  "server.ts",
  "server-usage-limits",
  "workgraph-execution",
  "central-runtime",
  "central-session-runtime",
  "workspace-runtime-integration/session-env",
  "channels-control-plane",
  "channels-dedup",
  "channel-delivery",
  "channel-run-audit",
  "whatsapp-baileys-auth-state",
  "control-plane/adapters/sqlite/central-store",
  "control-plane/adapters/sqlite/workspace-authority",
]

type ImportRef = { spec: string; typeOnly: boolean }

function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = []
  // `import ... from "x"` and `export ... from "x"`.
  const fromRe = /(?:^|\n)\s*(import|export)\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g
  for (let m = fromRe.exec(source); m; m = fromRe.exec(source)) {
    refs.push({ spec: m[3]!, typeOnly: !!m[2] })
  }
  // Side-effect `import "x"`.
  const sideRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g
  for (let m = sideRe.exec(source); m; m = sideRe.exec(source)) {
    refs.push({ spec: m[1]!, typeOnly: false })
  }
  // Dynamic `import("x")`.
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g
  for (let m = dynRe.exec(source); m; m = dynRe.exec(source)) {
    refs.push({ spec: m[1]!, typeOnly: false })
  }
  return refs
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
}

function walk() {
  const visited = new Set<string>()
  const bareImports: Array<{ from: string; spec: string }> = []
  const queue = ENTRYPOINTS.map((e) => path.join(SRC, e))

  while (queue.length) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = fs.readFileSync(file, "utf8")
    for (const ref of parseImports(source)) {
      if (ref.typeOnly) continue // erased by the bundler — not in the runtime graph.
      if (ref.spec.startsWith(".") || ref.spec.startsWith("/")) {
        const resolved = resolveRelative(file, ref.spec)
        if (resolved && !visited.has(resolved)) queue.push(resolved)
      } else {
        bareImports.push({ from: path.relative(SRC, file), spec: ref.spec })
      }
    }
  }
  return { visited, bareImports }
}

describe("worker import-graph", () => {
  const { visited, bareImports } = walk()
  const visitedRel = [...visited].map((f) => path.relative(SRC, f))

  test("Worker deployment keeps Node compatibility enabled for the native Daytona SDK driver", () => {
    // The Daytona SDK now enters the Worker bundle through the extracted
    // @claxedo/sandbox-manager package rather than a claxedo-server source
    // file: assert the graph reaches sandbox-manager, and that sandbox-manager
    // itself still pulls in @daytona/sdk.
    const sandboxManagerSpecs = bareImports
      .map((item) => item.spec)
      .filter((spec) => spec === "@claxedo/sandbox-manager" || spec.startsWith("@claxedo/sandbox-manager/"))
    expect(sandboxManagerSpecs.length).toBeGreaterThan(0)

    const sandboxManagerSrc = path.resolve(import.meta.dirname, "../../sandbox-manager/src")
    const sandboxManagerImportsDaytona = fs.readdirSync(sandboxManagerSrc)
      .filter((name) => name.endsWith(".ts"))
      .some((name) => fs.readFileSync(path.join(sandboxManagerSrc, name), "utf8").includes('"@daytona/sdk"'))
    expect(sandboxManagerImportsDaytona).toBe(true)

    const wrangler = fs.readFileSync(path.resolve(import.meta.dirname, "../wrangler.toml"), "utf8")
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]')
  })

  test("entrypoints are actually reachable (sanity)", () => {
    expect(visitedRel).toContain("worker.ts")
    expect(visitedRel).toContain("hosted-app.ts")
    // A representative deep node-safe dependency should be reachable.
    expect(visitedRel).toContain("routes/hosted-workspace.ts")
  })

  test("no local-only source module is in the Worker graph", () => {
    const leaked = visitedRel.filter(
      (rel) => FORBIDDEN_LOCAL.some((bad) => rel.includes(bad)),
    )
    expect(leaked, `local-only modules leaked into the Worker graph: ${leaked.join(", ")}`).toEqual([])
  })

  test("the sqlite central-store adapter is a forbidden local module absent from the Worker graph", () => {
    // Plan provenance: unit1-pin. Unit 6 (R8b) renamed sync-db.ts to
    // control-plane/adapters/sqlite/central-store.ts; the FORBIDDEN_LOCAL
    // entry followed the rename (never deleted), keeping the Worker boundary
    // closed around local sqlite-backed central persistence.
    expect(FORBIDDEN_LOCAL).toContain("control-plane/adapters/sqlite/central-store")
    expect(visitedRel.filter((rel) => rel.includes("central-store") || rel.includes("sync-db"))).toEqual([])
  })

  test("no Node-only or heavy package is imported by the Worker graph", () => {
    const leaked = bareImports.filter((b) => FORBIDDEN_BARE.includes(b.spec))
    const detail = leaked.map((b) => `${b.spec} (from ${b.from})`).join(", ")
    expect(leaked, `forbidden bare imports in the Worker graph: ${detail}`).toEqual([])
  })

  test("the Worker graph does not statically import control-plane/services.ts (avoids lazy fs credential chunk)", () => {
    // services.ts itself is fine, but its defaultControlPlaneCredentials lazily
    // imports the local credential registry (fs). The hosted composition uses
    // only `import type` from services.ts, so it must not appear in the graph.
    expect(visitedRel).not.toContain("control-plane/services.ts")
  })
})
