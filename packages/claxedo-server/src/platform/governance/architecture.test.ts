import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "./architecture"
import { architectureOwnershipEntries, OwnershipStatus } from "./architecture-ownership"
import { routeOwnership, RouteHandler } from "./route-ownership"
import { importPattern, walk } from "../../test-support/guards"

describe("architecture boundaries", () => {
  test("classifies host primitive architecture modules with owners and removal conditions", () => {
    const entries = architectureOwnershipEntries()
    const areas = new Set(entries.map((entry) => entry.area))
    expect([...areas].sort()).toEqual(["authority", "host", "lease", "mirror", "projection", "registry", "route"])

    const keys = entries.map((entry) => `${entry.area}:${entry.module}`)
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])

    for (const entry of entries) {
      const target = path.resolve(import.meta.dirname, "../..", entry.module)
      if (entry.status === OwnershipStatus.Deleted) {
        expect(fs.existsSync(target), `${entry.module} should stay deleted`).toBe(false)
        expect(entry.canonicalReplacement).toBeTruthy()
        continue
      }

      expect(fs.existsSync(target), `${entry.module} should exist`).toBe(true)
      expect(entry.owner, `${entry.module} needs an owner`).toBeTruthy()
      expect(entry.tests?.length, `${entry.module} needs active test coverage`).toBeGreaterThan(0)
      for (const testFile of entry.tests ?? []) {
        expect(
          fs.existsSync(path.resolve(import.meta.dirname, "../..", testFile)),
          `${entry.module} test missing: ${testFile}`,
        ).toBe(true)
      }

      if (entry.status === OwnershipStatus.Compatibility) {
        expect(entry.reason, `${entry.module} compatibility reason missing`).toBeTruthy()
        expect(entry.canonicalReplacement, `${entry.module} canonical replacement missing`).toBeTruthy()
        expect(entry.removalCondition, `${entry.module} removal condition missing`).toBeTruthy()
      }

      for (const sample of entry.routeSamples ?? []) {
        expect(routeOwnership(sample).handler, `${entry.module} route sample ${sample} is unclaimed`).not.toBe(
          RouteHandler.Unclaimed,
        )
      }
    }
  })


  test("keeps the server host bridge out of harness adapter execution", () => {
    const files = ["deployments/local/embedded-workspace-runtime.ts", "platform/http/sandbox-target-fetch.ts", "platform/http/proxy.ts", "config-fanout.ts"]
    const forbidden = [
      "@claxedo/agent-sdk-runtime",
      "AcpHarnessAdapter",
      "OpenCodeHarnessAdapter",
      "ClaudeHarnessAdapter",
      "CursorHarnessAdapter",
      "CodexHarnessAdapter",
    ]
    const hits = files.flatMap((file) => {
      // The boundary is about EXECUTION: the host bridge must not *run* harness
      // adapters. `import type ... ` is erased at compile time and produces no
      // runtime coupling, so a type-only import (e.g. a Pi backend resolver type
      // used to shape a config field) is not a violation — strip those lines
      // before scanning.
      const text = fs
        .readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf-8")
        .split("\n")
        .filter((line) => !/^\s*import\s+type\b/.test(line))
        .join("\n")
      return forbidden.flatMap((term) => (text.includes(term) ? [`${file}:${term}`] : []))
    })

    expect(hits).toEqual([])
  })


  test("keeps workspace-runtime from importing claxedo-server", () => {
    const workspaceRuntimeSrc = path.resolve(import.meta.dirname, "../../../../workspace-runtime/src")
    const forbidden = ["@claxedo/server", "@opencode-ai/claxedo-server", "@claxedo/claxedo-server", "claxedo-server"]
    const offenders = walk(workspaceRuntimeSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbidden.flatMap((term) =>
          importPattern(term).test(text) ? [`${path.relative(workspaceRuntimeSrc, file)}:${term}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })


  test("keeps product strings and ambient policy env reads out of the workspace-runtime kit", () => {
    const workspaceRuntimeSrc = path.resolve(import.meta.dirname, "../../../../workspace-runtime/src")
    // Product domains and host-policy env flags are HOST decisions
    // (kit-seams plan, Classification Rule). The kit must not embed them:
    // CORS whitelists arrive via options.corsOrigin, compat via
    // options.opencodeCompat.
    const forbidden = ["opencode.ai", "DISABLE_OPENCODE_COMPAT"]
    const offenders = walk(workspaceRuntimeSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbidden.flatMap((term) =>
          text.includes(term) ? [`${path.relative(workspaceRuntimeSrc, file)}:${term}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })


  test("keeps production source from importing legacy host-control modules", () => {
    const serverSrc = path.resolve(import.meta.dirname, "../..")
    const forbiddenModules = [
      "cloud/authority",
      "cloud/lifecycle",
      "cloud/sandbox",
      "../../sandbox-manager/src/sandbox-pool",
      "../../sandbox-manager/src/drivers/sandbox-bridge",
      "../../sandbox-manager/src/handle-providers",
      "../../sandbox-manager/src/sandbox-bridge-contract",
      "../../sandbox-manager/src/sandbox-bridge-provider",
      "../../sandbox-manager/src/workspace-runtime-process",
    ]
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.startsWith(path.join(serverSrc, "cloud", "sandbox") + path.sep))
      .filter((file) => !path.basename(file).startsWith("live-"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbiddenModules.flatMap((forbidden) =>
          importPattern(forbidden).test(text) ? [`${path.relative(serverSrc, file)}:${forbidden}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })


  test("keeps SandboxDriver focused on host lifecycle", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../sandbox-manager/src/index.ts"), "utf8")
    const start = text.indexOf("export type SandboxDriver = {")
    const end = text.indexOf("\n\nexport type SandboxManager =", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const driverContract = text.slice(start, end)
    const forbidden = [
      "executeCommand",
      "uploadFile",
      "createSession",
      "executeSessionCommand",
      "deleteSession",
      "launch",
      "restart",
      "recoverHost",
      "pty",
    ]

    expect(forbidden.filter((term) => new RegExp(`\\b${term}\\b`).test(driverContract))).toEqual([])
  })


  test("keeps sandbox-manager public types from becoming sandbox handles", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../sandbox-manager/src/index.ts"), "utf8")
    const forbidden = [
      "executeCommand",
      "uploadFile",
      "downloadFile",
      "readFile",
      "writeFile",
      "createSession",
      "executeSessionCommand",
      "deleteSession",
      "SandboxHandle",
      "SandboxProvider",
    ]

    expect(forbidden.filter((term) => text.includes(term))).toEqual([])
  })


  test("keeps SandboxManager wired to a driver, not a provider object", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../sandbox-manager/src/index.ts"), "utf8")
    const start = text.indexOf("export type SandboxManagerOptions = {")
    const end = text.indexOf("\n\nfunction sandboxId", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const optionsContract = text.slice(start, end)
    expect(optionsContract).toContain("driver: SandboxDriver")
    expect(optionsContract).not.toContain("provider: SandboxDriver")
  })


  test("keeps SandboxManager storage/auth pluggable", () => {
    const serverSrc = path.resolve(import.meta.dirname, "../..")
    const genericRuntimeHostFiles = [
      "../../sandbox-manager/src/index.ts",
      "../../sandbox-manager/src/stores/memory.ts",
    ]
    const forbiddenTerms = [
      "ConvexHttpClient",
      "convex/server",
      "service_token",
      "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN",
      "storage/workspace-lease.sql",
      "better-sqlite",
      "workspace/store",
      "workspaceStore",
      "process.env",
      "Bun.file",
      "Clerk",
      "billing",
      "usersMe",
    ]

    const offenders = genericRuntimeHostFiles.flatMap((file) => {
      const text = fs.readFileSync(path.resolve(serverSrc, file), "utf8")
      return forbiddenTerms
        .filter((term) => text.includes(term))
        .map((term) => `${file}:${term}`)
    })

    expect(offenders).toEqual([])
  })


  test("keeps generic control-plane core free of Convex tokens (R8)", () => {
    // Ownership-first: Convex is Claxedo's storage *decision*; only the Convex
    // (and the Worker composition) adapters under authority/adapters/* may
    // name it. Every other control-plane source file — imports, error codes,
    // field names, env names, comments — must be storage-agnostic. This is the
    // mechanical mirror of the kit's opencode.ai ban. Test files are excluded.
    // (Even the legacy backend-URL env aliases live in the Convex adapter now:
    // `convexAuthorityUrlFromEnv` — so this scan needs no carve-outs.)
    // Both halves of the control plane: the auth/identity machinery that moved
    // to platform/, and what is still in authority/ (services, projection-store,
    // the hosted-* composition). Scanning only one would quietly shrink this
    // guard's footprint to whichever half happened to move.
    const roots = [
      path.resolve(import.meta.dirname, "../auth"),
      path.resolve(import.meta.dirname, "../../authority"),
    ]
    const offenders = roots.flatMap((root) => walk(root)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.includes(`${path.sep}adapters${path.sep}`))
      .filter((file) => /convex/i.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(path.dirname(root), file)))
      .sort()

    expect(offenders).toEqual([])
  })


  test("keeps API error response bodies structured", () => {
    const files = [
      path.resolve(import.meta.dirname, "../../deployments/local/server.ts"),
      path.resolve(import.meta.dirname, "../http/proxy.ts"),
      ...walk(path.resolve(import.meta.dirname, "../../routes")).filter((file) => file.endsWith(".ts")),
    ]
    const rawScalarErrorBodies = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf-8")
      return [...text.matchAll(/(?:c\.json|Response\.json)\(\s*\{\s*(?:error|message):\s*["'`]/g)].map(
        (match) => `${path.relative(import.meta.dirname, file)}:${match.index}`,
      )
    })

    expect(rawScalarErrorBodies).toEqual([])
  })


  test("keeps package Agent Extension lifecycle modules free of server dependencies", () => {
    const root = path.resolve(import.meta.dirname, "../../../../agent-extensions/src")
    const lifecycleFiles = [
      "cache.ts",
      "facade.ts",
      "fetch.ts",
      "install.ts",
      "manifest.ts",
      "runtime-config.ts",
      "source.ts",
      "state.ts",
      "lock.ts",
      "storage.ts",
      "workspace.ts",
    ]
    const forbidden = ["../paths", "config-fanout", "workspace/supervisor", "ControlPlane", "Convex", "Hono"]
    const leaks = lifecycleFiles.flatMap((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf-8")
      return forbidden.flatMap((term) => (text.includes(term) ? [`${file}:${term}`] : []))
    })

    expect(leaks).toEqual([])
  })


  test("keeps WorkGraph out of Control Plane module load", () => {
    const server = fs.readFileSync(path.resolve(import.meta.dirname, "../../deployments/local/server.ts"), "utf-8")
    const serverWorkgraph = fs.readFileSync(path.resolve(import.meta.dirname, "../../hosts/workgraph/composition/server-workgraph.ts"), "utf-8")

    expect(server).not.toMatch(/from ["']@claxedo\/workgraph["']/)
    expect(server).not.toMatch(/from ["']\.\/workgraph-execution["']/)
    expect(serverWorkgraph).not.toMatch(/^import (?!type\b).*from ["']@claxedo\/workgraph["']/m)
    expect(serverWorkgraph).not.toMatch(/from ["']\.\/workgraph-execution["']/)
    expect(serverWorkgraph).toContain('import("@claxedo/workgraph")')
    expect(server).toContain('import("../../hosts/workgraph/composition/session-gateway")')
  })

  test("keeps test-support/ out of production modules", () => {
    // test-support/ is the ONE home for test-only in-process helpers. A
    // production module importing it would drag test doubles into runtime
    // bundles — and, worse, invert the dependency direction the directory
    // exists to make legible.
    const serverSrc = path.resolve(import.meta.dirname, "../..")
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !/\.(test|workerd\.test|miniflare\.test)\.ts$/.test(file))
      .filter((file) => !file.includes(`${path.sep}test-support${path.sep}`))
      .filter((file) => !path.basename(file).includes("test-helper"))
      .filter((file) => !path.basename(file).includes(".fixture."))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf-8")
        return /from ["'][^"']*test-support\//.test(text) ? [path.relative(serverSrc, file)] : []
      })

    expect(offenders).toEqual([])
  })

  test("keeps hand-written SQL out of feature code — drizzle tables are the only query surface", () => {
    // adapters/storage owns the schema; everything else queries through the
    // typed tables so a column rename is a compile error rather than a runtime
    // surprise. The channel stores were the last holdouts: 28 raw prepare()
    // calls against tables whose drizzle schemas existed but were never
    // imported (the schemas had even drifted — two were missing the composite
    // PRIMARY KEY the live DDL declares).
    //
    // `ClaxedoDB.raw()` on its own is NOT the violation — server.ts calls it
    // with no statement to eagerly open SQLite before serving. Executing a
    // hand-written statement is.
    const serverSrc = path.resolve(import.meta.dirname, "../..")
    const allowed = new Set([
      // The one documented escape hatch: a dynamic cursor-paginated query
      // whose shape drizzle's builder cannot express.
      path.join("session", "meta", "index.ts"),
    ])
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => path.relative(serverSrc, file))
      .filter((rel) => !allowed.has(rel) && !rel.startsWith(`adapters${path.sep}storage${path.sep}`))
      .filter((rel) => {
        const text = fs.readFileSync(path.join(serverSrc, rel), "utf-8")
        return /ClaxedoDB\.raw\(\)[\s\S]{0,40}?\.(prepare|exec)\(/.test(text)
      })

    expect(offenders).toEqual([])
  })
})
