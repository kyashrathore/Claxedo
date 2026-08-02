import { describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
// Cross-package import of the app's REAL marketplace parsers, so these tests
// break the moment the hosted stubs and the app disagree about response
// shapes. Legal here for the same reasons as doorbell-event-contract.test.ts:
// the `runtime contract` sibling-src ban scans production source only (it
// skips *.test.* files), and install-flow.ts is a pure zero-import module, so
// pulling it in needs no alias resolution and adds no runtime edge.
import {
  installedRecordsFromJson,
  machineItemsFromJson,
} from "../../../../claxedo-app/src/features/extensions/marketplace/install-flow"

/**
 * The hosted central serves the curated marketplace catalog and a (empty)
 * machine-scan, so the app's marketplace panel works without a local server.
 */
describe("hosted shell marketplace routes", () => {
  const app = HostedShellRoutes({
    authConfig: { enabled: false } as never,
  })

  test("serves the curated extension catalog with only resolvable sources", async () => {
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/agent-config/extensions/catalog"))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      version: number
      categories: unknown[]
      entries: Array<{ id: string; source: string; kind: string; firstParty?: string }>
    }
    expect(body.version).toBe(1)
    expect(body.entries.length).toBeGreaterThan(0)
    // Every entry must point at a GitHub source (owner/repo or tree URL) — no
    // placeholders that would 404 the install flow.
    for (const entry of body.entries) {
      expect(entry.source).toMatch(/github\.com|^[\w.-]+\/[\w.-]+/)
    }
    // The first-party Claxedo MCP is the canonical install-flow test target.
    expect(body.entries.some((e) => e.firstParty === "claxedo")).toBe(true)
    // The removed third-party monorepo servers must stay out.
    const ids = body.entries.map((e) => e.id)
    expect(ids).not.toContain("mcp-github")
    expect(ids).not.toContain("mcp-slack")
    expect(ids).not.toContain("mcp-postgres")
  })

  test("machine-scan returns an empty set on a hosted central (no local machine)", async () => {
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/agent-config/extensions/machine-scan"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
    // The app's `machineItemsFromJson` requires an array; anything else parses
    // to undefined and `loadMachineItems` silently bails.
    expect(machineItemsFromJson(body)).toEqual([])
  })

  test("installed-extensions list parses through the app's marketplace parser", async () => {
    // The panel calls this once per scope (machine, then project+directory).
    // `installedRecordsFromJson` only accepts the `extensionListBody` object
    // shape — on undefined the panel's `loadInstalled` bails without touching
    // `installedRecords`, so every card renders as not-installed and Install
    // re-runs on already-installed entries. The empty set must therefore be
    // the empty OBJECT shape, never a bare [].
    for (const query of ["?scope=machine", "?scope=project&directory=%2Fworkspace"]) {
      const res = await app.fetch(new Request(`http://cp.test/api/claxedo/agent-config/extensions${query}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      const records = installedRecordsFromJson(body, "machine", undefined)
      expect(records).toBeDefined()
      expect(records).toEqual([])
      // Exact shape of `extensionListBody()` (routes/agent-config-extension-
      // support.ts) with zero installs, including the `effective` policy map.
      expect(body).toEqual({
        desired: { version: 1, installs: [] },
        materialized: { version: 1, packages: {} },
        effective: {},
      })
    }
  })
})
