import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createSelfHostedApp } from "./app"
import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { verifyEmbeddedRuntimeCredential } from "@claxedo/local-server/self-hosted-execution"
import { createControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import {
  PRODUCT_ROUTE_FAMILIES,
  pathsByOwner,
  routeFamilyFor,
  unclassifiedPaths,
} from "@claxedo/server-core/deployments/product-route-families"

/**
 * Desktop-local product contract: the route families `@claxedo/local-server`
 * must serve, recorded from the self-hosted composition's inventory.
 *
 * The whole inventory is asserted rather than spot-checked because the failure
 * that matters is omission: a dropped `/api/wr/pty/:ptyID/connect` still
 * typechecks and builds, and surfaces only as a dead terminal in a packaged
 * desktop build.
 *
 * Runtime-owned paths such as `/api/wr/events` are dispatched by the
 * `workspaceRuntimeProxy` middleware, which registers no route, so they are
 * absent from the inventory by design rather than missing from the product.
 */

let dataDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-local-contract-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function localApp() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { authority: testManagedSessionAuthority(), localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
    {
      firstPartyMcp: {
        verifyRuntimeCredential: verifyEmbeddedRuntimeCredential,
        createClient: (input) => createClaxedoMcpClient(input),
        registerTools: CLAXEDO_MCP_TOOL_GROUPS,
      },
    },
  ).app
}

describe("route family table", () => {
  test("every family id is unique", () => {
    const ids = PRODUCT_ROUTE_FAMILIES.map((family) => family.id)
    expect(ids).toEqual([...new Set(ids)])
  })

  test("classifies a path by its most specific entry, not its first match", () => {
    // `/api/claxedo/network-policy` is a prefix of nothing else, but
    // `/api/claxedo/remote-access/devices` sits under a family whose bare path
    // also matches. Longest-entry-wins is what keeps those apart.
    expect(routeFamilyFor("/api/claxedo/remote-access/devices")?.id).toBe("remote-access-owner")
    expect(routeFamilyFor("/api/claxedo/remote-access/enable")?.id).toBe("remote-access-machine")
    expect(routeFamilyFor("/api/claxedo/network-policy/effective/:workspaceId")?.id).toBe("network-policy")
    expect(routeFamilyFor("/api/claxedo/workspace/resolve")?.id).toBe("local-workspace-resolve")
    expect(routeFamilyFor("/api/workspace/:id/host-assignment")?.id).toBe("workspace-authority")
  })

  test("reports an unowned path instead of silently absorbing it", () => {
    expect(routeFamilyFor("/api/claxedo/not-a-real-family")).toBeNull()
    expect(unclassifiedPaths([{ path: "/api/claxedo/not-a-real-family" }])).toEqual([
      "/api/claxedo/not-a-real-family",
    ])
  })
})

describe("desktop-local product contract", () => {
  test("every mounted route claims exactly one product family", () => {
    // The gate that makes the rest of this file trustworthy: a new route with
    // no declared owner fails here, so nobody can add a hosted capability to
    // the local composition without stating that they did.
    expect(unclassifiedPaths(localApp().routes)).toEqual([])
  })

  test("serves the complete local route-family allowlist", () => {
    expect(pathsByOwner(localApp().routes, "local-server")).toEqual([
      "/agent",
      "/api/claxedo/agent-config",
      "/api/claxedo/agent-config/agents",
      "/api/claxedo/agent-config/commands",
      "/api/claxedo/agent-config/commands/:name",
      "/api/claxedo/agent-config/connections",
      "/api/claxedo/agent-config/connections/:connectionId",
      "/api/claxedo/agent-config/harness",
      "/api/claxedo/agent-config/harness/options",
      "/api/claxedo/agent-config/mcp",
      "/api/claxedo/agent-config/mcp-install",
      "/api/claxedo/agent-config/mcp/:name",
      "/api/claxedo/agent-config/providers",
      "/api/claxedo/agent-config/providers/*",
      "/api/claxedo/agent-config/providers/auth",
      "/api/claxedo/agent-config/providers/custom",
      "/api/claxedo/bootstrap",
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/*",
      "/api/claxedo/credentials/:id",
      "/api/claxedo/credentials/:id/reconnect",
      "/api/claxedo/credentials/:id/scope",
      "/api/claxedo/credentials/:id/status",
      "/api/claxedo/credentials/:id/verify",
      "/api/claxedo/credentials/:providerId",
      "/api/claxedo/credentials/activate",
      "/api/claxedo/credentials/discover",
      "/api/claxedo/credentials/effective",
      "/api/claxedo/credentials/machine-logins",
      "/api/claxedo/credentials/provider/:providerId",
      "/api/claxedo/credentials/save-discovered",
      "/api/claxedo/credentials/sync-local",
      "/api/claxedo/health",
      "/api/claxedo/network-policy",
      "/api/claxedo/network-policy/:id",
      "/api/claxedo/network-policy/check",
      "/api/claxedo/network-policy/effective/:workspaceId",
      "/api/claxedo/network-policy/groups",
      "/api/claxedo/projects",
      "/api/claxedo/projects/:id",
      "/api/claxedo/projects/by-directory",
      "/api/claxedo/session",
      "/api/claxedo/session-list",
      "/api/claxedo/session/:id/meta",
      "/api/claxedo/track",
      "/api/claxedo/workspace",
      "/api/claxedo/workspace/resolve",
      "/api/control/orgs",
      "/api/control/orgs/:orgId/ensure-default-team",
      "/api/control/orgs/:orgId/teams",
      "/api/control/runtime/heartbeat",
      "/api/control/runtime/register",
      "/api/control/session-list",
      "/api/control/session-registrations/reserve",
      "/api/control/sessions",
      "/api/control/sessions/:sessionId/capabilities",
      "/api/control/sessions/:sessionId/gateway",
      "/api/control/sessions/:sessionId/messages",
      "/api/control/sessions/:sessionId/participants",
      "/api/control/sessions/:sessionId/shares",
      "/api/control/teams/:teamId/members",
      "/api/control/teams/:teamId/projects",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
      "/api/cp/events",
      "/api/wr/pty/:ptyID/connect",
      "/command",
      "/experimental/worktree",
      "/experimental/worktree/reset",
      "/file",
      "/file/all",
      "/file/content",
      "/file/status",
      "/find",
      "/find/file",
      "/global/health",
      "/path",
      "/project",
      "/project/:projectId",
      "/project/current",
      "/provider/*",
      "/provider/:providerId/oauth/*",
      "/provider/:providerId/oauth/authorize",
      "/provider/:providerId/oauth/callback",
      "/provider/auth",
      "/workspaces/:workspaceId",
      "/workspaces/:workspaceId/*",
      "/workspaces/:workspaceId/api/wr/pty/:ptyID/connect",
    ])
  })

  test("records the hosted-owned route families the desktop-local product mounts but does not own", () => {
    expect(pathsByOwner(localApp().routes, "server")).toEqual([
      "/.well-known/jwks.json",
      "/api/channels/discord",
      "/api/channels/discord/*",
      "/api/channels/fake",
      "/api/channels/github",
      "/api/channels/github/*",
      "/api/channels/identity",
      "/api/channels/pairing",
      "/api/channels/pairing/approve",
      "/api/channels/pairing/claim",
      "/api/channels/slack",
      "/api/channels/slack/*",
      "/api/channels/telegram",
      "/api/channels/telegram/*",
      "/api/channels/whatsapp",
      "/api/channels/whatsapp/*",
      "/api/claxedo/host/enrollments",
      "/api/claxedo/host/enrollments/:id/display-name",
      "/api/claxedo/host/enrollments/:id/provider-config",
      "/api/claxedo/host/enrollments/:id/scope",
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
      "/api/claxedo/host/enrollments/pause",
      "/api/claxedo/host/enrollments/redeem",
      "/api/claxedo/host/enrollments/requests",
      "/api/claxedo/host/invitations",
      "/api/claxedo/host/invitations/:id",
      "/api/claxedo/integrations",
      "/api/claxedo/integrations/:id/connect",
      "/api/claxedo/integrations/attempts/:state",
      "/api/claxedo/integrations/callback",
      "/api/claxedo/integrations/connections/:id",
      "/api/claxedo/integrations/connections/:id/auth-failure",
      "/api/claxedo/integrations/connections/:id/repositories",
      "/api/claxedo/integrations/connections/:id/reverify",
      "/api/claxedo/integrations/connections/:id/token",
      "/api/claxedo/mcp",
      "/api/claxedo/project/remote",
      "/api/claxedo/remote-access",
      "/api/claxedo/remote-access/devices",
      "/api/claxedo/remote-access/devices/:hostId",
      "/api/claxedo/remote-access/workspaces/:workspaceId/second-device-open",
      "/api/runtime-authority/session-authorize",
      "/api/workspace",
      "/api/workspace/:id",
      "/api/workspace/:id/checkpoints",
      "/api/workspace/:id/checkpoints/:checkpointId/restore",
      "/api/workspace/:id/connection",
      "/api/workspace/:id/connection/refresh",
      "/api/workspace/:id/host-assignment",
      "/api/workspace/:id/lifecycle/:operation",
      "/api/workspace/create",
      "/api/workspace/drivers",
      "/api/workspace/drivers/:id/auth",
      "/api/workspace/drivers/default",
      "/api/workspace/resolve",
      "/documents",
      "/documents/:id",
      "/documents/:id/agent-open",
      "/documents/:id/archive",
      "/documents/:id/availability",
      "/documents/:id/content",
      "/documents/:id/export",
      "/documents/:id/git/commit",
      "/documents/:id/git/snapshot",
      "/documents/:id/move-to-repository",
      "/documents/:id/relocate",
      "/documents/:id/restore",
      "/documents/:id/runtime-capability/renew",
      "/documents/:id/runtime-conflict/resolve",
      "/documents/:id/runtime-job",
      "/documents/:id/runtime-writeback",
      "/documents/:id/session",
      "/documents/:id/snapshots",
      "/documents/:id/snapshots/:snapshotId/restore",
      "/documents/:id/snapshots/:snapshotId/work-source-pin",
      "/documents/:id/work-source",
      "/documents/from-repo",
      "/documents/remote",
      "/documents/statuses",
      "/internal/documents/*",
      "/internal/documents/:id",
      "/internal/documents/index",
      "/internal/documents/jobs/activate",
      "/internal/documents/jobs/revoke",
      "/internal/relay/*",
      "/internal/relay/host-generation",
      "/internal/relay/revocation",
      "/internal/relay/target",
    ])
  })

  test("records the machine-publication routes Host Connector takes over", () => {
    expect(pathsByOwner(localApp().routes, "host-connector")).toEqual([
      "/api/claxedo/remote-access/enable",
    ])
  })

  test("answers health and bootstrap without any hosted service configured", async () => {
    const app = localApp()

    const health = await app.request("/api/claxedo/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, localExecution: true })

    const global = await app.request("/global/health")
    expect(global.status).toBe(200)
    expect(await global.json()).toMatchObject({ healthy: true })
  })

  test("tells the Codex connect card which sign-in methods its account has", async () => {
    const app = localApp()

    const response = await app.request("/api/claxedo/agent-config/providers/auth?nativeHarness=codex")
    expect(response.status).toBe(200)
    const methods = (await response.json())["codex-app-server"]
    // The card signs in with the position, so the position is the contract.
    expect(methods[0]).toMatchObject({ type: "oauth" })
    expect(methods.map((method: { type: string }) => method.type)).toEqual(["oauth", "api"])
  })

  test("refuses a harness the card cannot sign in to rather than answering an empty card", async () => {
    const response = await localApp().request("/api/claxedo/agent-config/providers/auth?nativeHarness=unknown")

    expect(response.status).toBe(400)
  })

  test("answers the workspace list in one envelope, signed or not, so the MCP client can read it", async () => {
    const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
    const shared = await ensureWorkspace({ kind: "cloud", driver: "daytona", workspace_name: "shared box", directory: "/srv/repo", remote_directory: "/srv/repo" })
    if (!shared) throw new Error("the store refused the fixture workspace")
    const app = localApp()

    for (const host of ["provisioner", "machine"] as const) {
      const response = await app.request(`/api/workspace?host=${host}`)
      expect(response.status, host).toBe(200)
      expect(await response.json(), host).toMatchObject({ workspaces: expect.any(Array) })
    }

    const client = createClaxedoMcpClient({
      deployment: "node",
      local: { fetch: async (path, init) => await app.request(path, init), workspace: { workspaceId: shared.id } },
      controlPlane: { fetch: async (path, init) => await app.request(path, init) },
    })
    expect((await client.workspaces()).map((row) => ({ id: row.id, host: row.host, name: row.name })))
      .toEqual([{ id: shared.id, host: "provisioner", name: "shared box" }])
  })

  test("resolves the profile root from the product data directory, not the package location", async () => {
    // A package move must not relocate durable state: the same env var selects
    // the same profile whichever package serves it.
    const { dataDir: resolveDataDir } = await import("@claxedo/server-core/platform/runtime/lib/paths")
    expect(resolveDataDir()).toBe(dataDir)
  })
})
