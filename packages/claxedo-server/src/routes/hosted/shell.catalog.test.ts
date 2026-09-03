import { describe, expect, test, vi } from "vitest"
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

  test("acp-connections refuses an anonymous caller", async () => {
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/agent-config/harness/acp-connections"))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: { code: "missing_bearer_token", message: "Authorization: Bearer token is required" },
    })
  })

  test("acp-connections returns the valid empty shape once signed (no local machine)", async () => {
    const signed = HostedShellRoutes({
      authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async (token) => ({
        mode: "signed",
        token,
        user: { subject: "user_1", tokenIdentifier: "token_1", issuer: "https://auth.test" },
      }),
    })
    const res = await signed.fetch(
      new Request("http://cp.test/api/claxedo/agent-config/harness/acp-connections", {
        headers: { authorization: "Bearer hosted-token" },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // The app's `decodeAcpConnectionRows` accepts only `{ connections: [...] }`
    // (a bare [] or a 404 body both decode to "no rows", which is why the 404
    // was invisible in the UI and loud in the console). It is NOT imported
    // here: unlike install-flow.ts it reaches for the app's `@/` alias, which
    // this package cannot resolve — the header above is the rule.
    expect(body).toEqual({ connections: [] })
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

  test("workspace extension enable writes through the signed hosted authority", async () => {
    const setWorkspaceAgentExtensionEnabled = vi.fn(async () => ({ updated: true }))
    const workspace = HostedShellRoutes({
      authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async (token) => ({
        mode: "signed",
        token,
        user: { subject: "user_1", tokenIdentifier: "token_1", issuer: "https://auth.test" },
      }),
      workspaceAgentExtensions: {
        listWorkspaceAgentExtensions: async () => [],
        authorizeWorkspaceAgentExtensionsAdmin: async () => undefined,
        setWorkspaceAgentExtensionEnabled,
        deleteWorkspaceAgentExtension: async () => ({ deleted: true }),
      },
    })

    const response = await workspace.request(
      "/api/claxedo/agent-config/extensions/review/enable?scope=workspace&workspaceId=ws_1",
      { method: "POST", headers: { authorization: "Bearer hosted-token" } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(setWorkspaceAgentExtensionEnabled).toHaveBeenCalledWith(expect.objectContaining({ token: "hosted-token" }), {
      workspaceId: "ws_1",
      extensionId: "review",
      enabled: true,
    })
  })
})

describe("signed shell projects", () => {
  const cloudRow = (workspaceId: string, name = workspaceId) => ({
    workspace_id: workspaceId,
    display_name: name,
    project_id: workspaceId,
    backing: "cloud-vm",
    access: "cloud",
    remote_directory: "/workspace",
    created_at: 1_000,
    updated_at: 2_000,
  })

  // The composer's project chip showed "workspace" for every hosted cloud
  // project: `display_name` is the WORKSPACE name and the hosted create dialog
  // posts `workspaceName: "main"`, so preferring it named the PROJECT "main";
  // with no name at all the client fell through to the directory basename, and
  // every hosted cloud workspace lives in the literal directory "/workspace".
  test("names a hosted cloud project after its repo, not the workspace name", async () => {
    const { signedShellProjects } = await import("./shell")
    const [project] = signedShellProjects(
      [{
        ...cloudRow("ws_1", "main"),
        project_id: "proj_1",
        repo_url: "https://github.com/claxedo/opencode.git",
      }],
      3_000,
    )
    expect(project?.name).toBe("claxedo/opencode")
    // …and the repo identity reaches the client, so it can derive a label of
    // its own without a second round-trip.
    expect(project?.workspaces?.ws_1).toMatchObject({
      repo_url: "https://github.com/claxedo/opencode.git",
    })
  })

  test("prefers an explicit repo_name over the parsed remote", async () => {
    const { signedShellProjects } = await import("./shell")
    const [project] = signedShellProjects(
      [{ ...cloudRow("ws_1", "main"), project_id: "proj_1", repo_name: "opencode", repo_url: "https://github.com/claxedo/opencode.git" }],
      3_000,
    )
    expect(project?.name).toBe("opencode")
  })

  // A project's rows are not uniform — only some carry repo identity. The group
  // is opened by whichever row is seen FIRST, so a bare row must not lock in
  // the raw project id as the project's name forever.
  test("a later row carrying repo identity upgrades a placeholder project name", async () => {
    const { signedShellProjects } = await import("./shell")
    const [project] = signedShellProjects(
      [
        { ...cloudRow("ws_bare", "main"), project_id: "proj_1", display_name: undefined },
        { ...cloudRow("ws_repo", "main"), project_id: "proj_1", repo_url: "git@github.com:claxedo/opencode.git" },
      ],
      3_000,
    )
    expect(project?.name).toBe("claxedo/opencode")
  })

  // Both cloud workspaces of one project must survive grouping — this is the
  // list the composer's third select offers as "pick an existing workspace".
  test("keeps every cloud workspace of a project as a selectable sandbox", async () => {
    const { signedShellProjects } = await import("./shell")
    const [project] = signedShellProjects(
      [
        { ...cloudRow("ws_1", "main"), project_id: "proj_1", repo_url: "https://github.com/claxedo/opencode.git" },
        { ...cloudRow("ws_2", "feature"), project_id: "proj_1", repo_url: "https://github.com/claxedo/opencode.git" },
      ],
      3_000,
    )
    expect(project?.sandboxes).toEqual(["ws_1", "ws_2"])
    expect(Object.keys(project?.workspaces ?? {})).toEqual(["ws_1", "ws_2"])
  })
})
