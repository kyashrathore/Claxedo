import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
// Recursive file listing. Aliased because this module already has a local
// `walk()` that walks the IMPORT graph rather than the filesystem.
import { walk as walkAll } from "../../test-support/guards"

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

const SRC = path.resolve(import.meta.dirname, "../..")
const ENTRYPOINTS = ["deployments/hosted-workerd/worker.ts", "deployments/hosted-shared/hosted-app.ts"]

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
  "workspace/store",
  "workspace/supervisor",
  "embedded-workspace-runtime",
  "user-hosted-tunnel",
  "adapters/credentials/store",
  "adapters/credentials/registry",
  "credentials/backends/local",
  "cloud/sandbox",
  "server.ts",
  "server-usage-limits",
  "workgraph-execution",
  "server-workgraph",
  "central-runtime",
  "central-session-runtime",
  "hosts/workspace-runtime/session-env",
  "channels/control-plane",
  "channels/dedup",
  "channels/delivery",
  "channels/run-audit",
  "channels/whatsapp-baileys-auth-state",
  "authority/adapters/sqlite/central-store",
  "authority/adapters/sqlite/workspace-authority",
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

  test("Worker deployment keeps native SDK compatibility and public Worker-to-Worker fetch enabled", () => {
    // The Daytona SDK now enters the Worker bundle through the extracted
    // @claxedo/sandbox-manager package rather than a claxedo-server source
    // file: assert the graph reaches sandbox-manager, and that sandbox-manager
    // itself still pulls in @daytona/sdk.
    const sandboxManagerSpecs = bareImports
      .map((item) => item.spec)
      .filter((spec) => spec === "@claxedo/sandbox-manager" || spec.startsWith("@claxedo/sandbox-manager/"))
    expect(sandboxManagerSpecs.length).toBeGreaterThan(0)

    const sandboxManagerSrc = path.resolve(import.meta.dirname, "../../../../sandbox-manager/src")
    const sandboxManagerImportsDaytona = fs
      .readdirSync(sandboxManagerSrc)
      .filter((name) => name.endsWith(".ts"))
      .some((name) => fs.readFileSync(path.join(sandboxManagerSrc, name), "utf8").includes('"@daytona/sdk"'))
    expect(sandboxManagerImportsDaytona).toBe(true)

    const wrangler = fs.readFileSync(path.resolve(import.meta.dirname, "../../../wrangler.toml"), "utf8")
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')
  })

  test("entrypoints are actually reachable (sanity)", () => {
    expect(visitedRel).toContain("deployments/hosted-workerd/worker.ts")
    expect(visitedRel).toContain("deployments/hosted-shared/hosted-app.ts")
    expect(visitedRel).toContain("hosts/workgraph/hosted/index.ts")
    expect(visitedRel).toContain("hosts/workgraph/hosted/runtime.ts")
    expect(visitedRel).toContain("documents/routes/index.ts")
    expect(visitedRel).not.toContain("routes/docs.ts")
    expect(visitedRel).not.toContain("document-store.ts")
    expect(visitedRel).not.toContain("doc-store.ts")
    // A representative deep node-safe dependency should be reachable.
    expect(visitedRel).toContain("routes/hosted/workspace.ts")
  })

  test("no local-only source module is in the Worker graph", () => {
    const leaked = visitedRel.filter((rel) => FORBIDDEN_LOCAL.some((bad) => rel.includes(bad)))
    expect(leaked, `local-only modules leaked into the Worker graph: ${leaked.join(", ")}`).toEqual([])
  })

  test("the sqlite central-store adapter is a forbidden local module absent from the Worker graph", () => {
    // Plan provenance: unit1-pin. Unit 6 (R8b) renamed sync-db.ts to
    // authority/adapters/sqlite/central-store.ts; the FORBIDDEN_LOCAL
    // entry followed the rename (never deleted), keeping the Worker boundary
    // closed around local sqlite-backed central persistence.
    expect(FORBIDDEN_LOCAL).toContain("authority/adapters/sqlite/central-store")
    expect(visitedRel.filter((rel) => rel.includes("central-store") || rel.includes("sync-db"))).toEqual([])
  })

  test("no Node-only or heavy package is imported by the Worker graph", () => {
    const leaked = bareImports.filter((b) => FORBIDDEN_BARE.includes(b.spec))
    const detail = leaked.map((b) => `${b.spec} (from ${b.from})`).join(", ")
    expect(leaked, `forbidden bare imports in the Worker graph: ${detail}`).toEqual([])
  })

  test("the Worker graph does not statically import authority/services.ts (avoids lazy fs credential chunk)", () => {
    // services.ts itself is fine, but its defaultControlPlaneCredentials lazily
    // imports the local credential registry (fs). The hosted composition uses
    // only `import type` from services.ts, so it must not appear in the graph.
    expect(visitedRel).not.toContain("authority/services.ts")
  })

  // The `.cf.ts` suffix marks a module that CANNOT run outside the Cloudflare
  // runtime (Durable Object classes, `cloudflare:workers`, KV/R2 bindings).
  // Without the two tests below the suffix is only a comment, free to drift
  // from reality. With them it is a checked invariant in BOTH directions:
  // nothing workerd-only escapes the marker, and nothing marked escapes the
  // Worker graph.
  //
  // Deliberately NOT marked: the ~57 `hosted-*` files. "hosted" is a trust
  // posture (signed multi-tenant), not a runtime — hosted-app.ts is mounted by
  // hosted-node.ts on Node as well as by worker.ts on workerd.

  test("every workerd-only module carries the .cf.ts marker", () => {
    const workerdOnly = walkAll(SRC)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8")
        return (
          /from\s+["']cloudflare:workers["']/.test(text) ||
          /\bDurableObjectState\b/.test(text) ||
          /\bextends\s+DurableObject\b/.test(text) ||
          // Storage bindings. A module written against R2's conditional-write
          // semantics (`onlyIf.etagMatches` is what makes CAS work without a
          // lock) or KV cannot be re-pointed at another blob store without
          // re-deriving its concurrency argument, so it targets this runtime
          // even when the binding type is declared structurally.
          /\bR2Bucket\b/.test(text) ||
          /\bKVNamespace\b/.test(text)
        )
      })
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !rel.endsWith(".cf.ts"))
      .sort()

    expect(
      workerdOnly,
      `workerd-only modules missing the .cf.ts marker: ${workerdOnly.join(", ")}`,
    ).toEqual([])
  })

  test("a .cf.ts module is only reachable from the Worker entrypoints", () => {
    // Every .cf.ts file on disk...
    const marked = walkAll(SRC)
      .filter((file) => file.endsWith(".cf.ts"))
      .map((file) => path.relative(SRC, file))
      .sort()
    expect(marked.length, "expected at least one .cf.ts module").toBeGreaterThan(0)

    // ...must not be imported by any module OUTSIDE the Worker graph. A local
    // (Node) composition reaching into workerd-only code would only fail at
    // deploy time, which is exactly the class of break this guard exists for.
    const workerGraph = new Set(visitedRel)
    const offenders: string[] = []
    for (const file of walkAll(SRC).filter((f) => f.endsWith(".ts"))) {
      const rel = path.relative(SRC, file)
      if (rel.endsWith(".test.ts") || rel.endsWith(".cf.ts") || workerGraph.has(rel)) continue
      for (const ref of parseImports(fs.readFileSync(file, "utf8"))) {
        if (ref.typeOnly) continue
        if (!ref.spec.startsWith(".")) continue
        const resolved = resolveRelative(file, ref.spec)
        if (resolved?.endsWith(".cf.ts")) {
          offenders.push(`${rel} -> ${path.relative(SRC, resolved)}`)
        }
      }
    }

    expect(offenders, `non-Worker modules importing .cf.ts: ${offenders.join(", ")}`).toEqual([])
  })
})
