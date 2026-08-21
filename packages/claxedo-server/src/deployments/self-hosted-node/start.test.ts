import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SelfHostedCompositionError, assertSelfHostedPosture } from "./posture"
import { selfHostedPosture, staticAppPosture } from "./start"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"

/**
 * The self-hosted entry's posture reading, and the wiring that makes it run.
 *
 * `startSelfHostedServer` itself boots a real server, so what is testable is
 * split out: `selfHostedPosture` observes, `assertSelfHostedPosture` judges,
 * and a source check confirms the entry calls them in that order before
 * composing anything. Booting to find out would mean the operator learns from
 * a user rather than a log line.
 */

/**
 * Which authority factory the REAL composition invoked.
 *
 * The posture's `sqliteAuthority` field is a data-residency claim, so a test
 * that asserts it against the value the same function just produced proves
 * nothing — that is exactly how it stayed a hard-coded `true` while
 * `createDefaultLocalControlPlaneServices` selected Convex. Both adapter
 * modules are wrapped rather than replaced: the composition builds its real
 * authority, and the wrapper only records which branch ran.
 */
const composedAuthorities = vi.hoisted(() => [] as Array<"convex" | "sqlite">)

vi.mock("../../authority/adapters/convex/workspace-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../authority/adapters/convex/workspace-authority")>()
  return {
    ...actual,
    createConvexAuthority: (input?: Parameters<typeof actual.createConvexAuthority>[0]) => {
      composedAuthorities.push("convex")
      return actual.createConvexAuthority(input)
    },
  }
})

vi.mock("@claxedo/server-core/authority/adapters/sqlite/workspace-authority", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority")
  >()
  return {
    ...actual,
    createSqliteWorkspaceAuthority: (...args: Parameters<typeof actual.createSqliteWorkspaceAuthority>) => {
      composedAuthorities.push("sqlite")
      return actual.createSqliteWorkspaceAuthority(...args)
    },
  }
})

const start = readFileSync(path.join(import.meta.dirname, "start.ts"), "utf8")
const entry = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8")

describe("selfHostedPosture", () => {
  test("reads the deployment mode from the environment", () => {
    // `local` is the self-hosted binary's TRUST posture; the mode enum is not
    // a product name. See the table in `posture.ts`.
    expect(selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "local" })).toMatchObject({ deploymentMode: "local" })
  })

  test("what it reports passes the gate for a correctly configured self-host", () => {
    // The two halves have to agree. A posture reader that produced a shape the
    // assertion rejects would make every self-host refuse to start.
    const posture = selfHostedPosture({
      CLAXEDO_DEPLOYMENT_MODE: "local",
      CLAXEDO_EMBEDDED_AUTH: "1",
    })

    expect(() => assertSelfHostedPosture(posture)).not.toThrow()
  })

  test("a hosted-mode environment is refused", () => {
    const posture = selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "hosted", CLAXEDO_EMBEDDED_AUTH: "1" })

    expect(() => assertSelfHostedPosture(posture)).toThrow(SelfHostedCompositionError)
  })

  test("an environment with no embedded auth still starts", () => {
    // The single-user self-host.  is the multi-user
    // opt-in, and refusing without it would break a deployment that works.
    expect(() => assertSelfHostedPosture(selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "local" }))).not.toThrow()
  })
})

describe("the reported authority is the one the composition builds", () => {
  /**
   * Drives `createDefaultLocalControlPlaneServices` — the function the
   * self-hosted entry reaches through `startServer` — and compares what it
   * selected against what `selfHostedPosture` reports for the SAME
   * environment. `process.env` is what both read, so the two cannot be given
   * different inputs.
   */
  const saved: Record<string, string | undefined> = {}
  const dataDirs: string[] = []

  function setEnv(key: string, value: string | undefined) {
    if (!(key in saved)) saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
      delete saved[key]
    }
    // Close the sqlite handles each composition opened under its data dir:
    // Windows refuses to delete a directory holding an open database file,
    // and keeps a brief lock even after close (the retries absorb it).
    ClaxedoDB.close()
    closeAuthorityDatabases()
    while (dataDirs.length > 0) rmSync(dataDirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  async function compose(authorityUrl: string | undefined) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-posture-authority-"))
    dataDirs.push(dataDir)
    setEnv("CLAXEDO_DATA_DIR", dataDir)
    setEnv("CLAXEDO_DEPLOYMENT_MODE", "local")
    setEnv("CLAXEDO_SIGNED_CLOUD_AUTH", undefined)
    // Left OFF deliberately: the embedded Better Auth issuer runs its own
    // migrations asynchronously against `CLAXEDO_DATA_DIR`, and this test tears
    // that directory down. The authority branch under test does not read it.
    setEnv("CLAXEDO_EMBEDDED_AUTH", undefined)
    setEnv("CLAXEDO_WORKSPACE_AUTHORITY_URL", authorityUrl)

    composedAuthorities.length = 0
    const { createDefaultLocalControlPlaneServices } = await import("./app")
    createDefaultLocalControlPlaneServices()

    return { composed: [...composedAuthorities], posture: selfHostedPosture(process.env) }
  }

  test("with no authority URL it composes SQLite, and says so", async () => {
    const { composed, posture } = await compose(undefined)

    expect(composed).toEqual(["sqlite"])
    expect(posture.sqliteAuthority).toBe(true)
    expect(() => assertSelfHostedPosture(posture)).not.toThrow()
  })

  test("local trust ignores a stale authority URL in both composition and posture", async () => {
    // A developer may have a hosted URL in an ambient env file, but local
    // trust must neither move self-hosted data to Convex nor refuse to boot.
    const { composed, posture } = await compose("https://authority.example.convex.cloud")

    expect(composed).toEqual(["sqlite"])
    expect(posture.sqliteAuthority).toBe(true)
    expect(() => assertSelfHostedPosture(posture)).not.toThrow()
  })

  test("a blank authority URL is not a remote authority", async () => {
    // `convexAuthorityUrlFromEnv` trims and treats empty as absent; a posture
    // that read the variable itself would refuse a deploy over whitespace.
    const { composed, posture } = await compose("   ")

    expect(composed).toEqual(["sqlite"])
    expect(posture.sqliteAuthority).toBe(true)
  })
})

describe("staticAppPosture", () => {
  test("reports nothing when no bundle is configured", () => {
    // An API-only self-host is supported; absence must not read as an error.
    expect(staticAppPosture(undefined)).toEqual({})
  })

  test("reports a configured directory that does not exist", () => {
    // A build step did not run. Serving the API with no UI reads as a broken
    // app rather than a broken deploy.
    expect(staticAppPosture("/definitely/not/here")).toEqual({
      staticAppDir: "/definitely/not/here",
      staticAppDirExists: false,
    })
  })
})

describe("the self-hosted entry wiring", () => {
  test("asserts the posture before composing anything", () => {
    // Order is the property. A gate that ran after `startServer` would let the
    // listener come up on a configuration it was about to reject.
    expect(start.indexOf("assertSelfHostedPosture(")).toBeLessThan(start.indexOf("return startServer("))
  })

  test("the process entry goes through the gated start, not startServer", () => {
    // `startServer` had exactly one production caller left after Unit 5 — this
    // entry. Calling it directly would skip the gate entirely.
    expect(entry).toContain("startSelfHostedServer({")
    expect(entry).not.toContain("startServer(")
  })

  test("passes the self-hosted capability factory", () => {
    // The single argument that keeps WorkGraph and Documents composed after the
    // desktop-local composition stopped contributing any. Dropping it would
    // silently remove two features from the self-hosted product.
    expect(start).toContain("capabilities: selfHostedCapabilities")
  })
})
