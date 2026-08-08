import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

const ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * What the desktop-local server closes over.
 *
 * When this measurement started, the desktop-local entry reached 259 first-party
 * modules and 42 packages — Convex, better-auth, WorkGraph, channels,
 * connections, wakes — from a build that never signs in. Most of that came from
 * sharing one package with the hosted product. The manifest now states
 * ownership directly, and this file is the check that the source agrees with the
 * manifest.
 */
const PRODUCERS = [
  "src/deployments/local/embedded-workspace-runtime.ts",
  "src/deployments/local/server-workspace-pty-proxy.ts",
  "src/deployments/local/server-usage-limits.ts",
  "src/deployments/local/port.ts",
  "src/workspace/runtime-dispatch/internals.ts",
  "src/workspace/runtime-dispatch/middleware.ts",
  "src/agent-config/routes/index.ts",
  "src/credentials/routes/credential.ts",
  "src/credentials/routes/provider-auth.ts",
  "src/session/routes/meta-routes.ts",
  "src/deployments/shared-routes/bootstrap.ts",
  "src/sandbox/network/network-policy-routes.ts",
  "src/opencode/compat-routes/index.ts",
]

/**
 * Packages that must never appear in this product's closure. Each is a hosted
 * capability the unsigned desktop has no way to use and no business carrying.
 */
const FORBIDDEN_PACKAGES = [
  "@claxedo/server",
  "@claxedo/workgraph",
  "@claxedo/channels",
  "@claxedo/connections",
  "@claxedo/wakes",
  "convex",
  "better-auth",
  "posthog-node",
]

function closure(options: { runtimeOnly?: boolean } = {}) {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const unresolved: string[] = []
  const opaque: string[] = []
  for (const producer of PRODUCERS) {
    const result = sourceClosure({ entry: path.join(ROOT, producer), root: ROOT, ...options })
    for (const module of result.modules) {
      if (!module.relative.includes(".test.")) modules.add(module.relative)
    }
    for (const name of result.packages) packages.add(name)
    unresolved.push(...result.unresolved)
    opaque.push(...result.opaque)
  }
  return { modules, packages, unresolved: [...new Set(unresolved)], opaque: [...new Set(opaque)] }
}

describe("@claxedo/local-server closure", () => {
  it("reaches no hosted capability package", () => {
    const { packages } = closure()
    expect(FORBIDDEN_PACKAGES.filter((name) => packages.has(name))).toEqual([])
  })

  it("declares every package it reaches", () => {
    // A package reached but not declared works only by hoisting — it is a
    // dependency this manifest does not own, and it can vanish under a
    // different install layout.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])
    const undeclared = [...closure().packages]
      .filter((name) => !name.startsWith("node:"))
      .filter((name) => !declared.has(name))
      // Node built-ins reached without the `node:` prefix.
      .filter((name) => !["fs", "path", "os", "crypto", "url", "child_process", "module", "http", "https", "net", "util", "events", "stream", "buffer", "zlib", "tty", "assert", "dns"].includes(name))
    expect(undeclared).toEqual([])
  })

  it("resolves every relative specifier, so the measurement is complete", () => {
    expect(closure().unresolved).toEqual([])
  })

  it("contains no import the walk cannot follow", () => {
    // `import(someVariable)` is invisible to this walk and to the typechecker.
    // Three such edges lived in this codebase to keep Node-only modules out of
    // a Worker bundle; one survived a package move and broke at runtime with a
    // clean import graph the whole time. They are ports now, and this keeps
    // them from coming back.
    expect(closure().opaque).toEqual([])
  })

  it("stays within its measured size", () => {
    // Measured 2026-08-08 at package creation. A rise means this product grew
    // surface; a fall should lower the ceiling with it.
    const { modules, packages } = closure({ runtimeOnly: true })
    expect(modules.size).toBeLessThanOrEqual(50)
    expect(packages.size).toBeLessThanOrEqual(22)
  })
})
