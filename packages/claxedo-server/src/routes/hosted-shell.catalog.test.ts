import { describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./hosted-shell"

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
    expect(await res.json()).toEqual([])
  })
})
