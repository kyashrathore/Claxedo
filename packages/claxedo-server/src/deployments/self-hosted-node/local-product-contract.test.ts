import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createSelfHostedApp } from "./app"
import { createControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import {
  PRODUCT_ROUTE_FAMILIES,
  pathsByOwner,
  routeFamilyFor,
  unclassifiedPaths,
} from "@claxedo/server-core/deployments/product-route-families"

/**
 * Desktop-local product contract.
 *
 * This is the oracle Unit 5 has to satisfy. `@claxedo/local-server` is not
 * "whatever compiles after moving files" — it is exactly the set of route
 * families recorded here, served from the same paths, reading the same profile
 * root. Without this table the extraction has no failing condition: a move that
 * silently dropped `/api/wr/pty/:ptyID/connect` would still typecheck, still
 * build, and only surface as a dead terminal in a packaged desktop build.
 *
 * The suite deliberately asserts the WHOLE inventory rather than spot-checking
 * a few paths. A partial assertion cannot detect the failure mode that matters
 * here, which is omission.
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
      { localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
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
    expect(routeFamilyFor("/api/claxedo/remote-access/devices")?.id).toBe("remote-access")
    expect(routeFamilyFor("/api/claxedo/network-policy/effective/:workspaceId")?.id).toBe("network-policy")
    expect(routeFamilyFor("/api/claxedo/workspace/resolve")?.id).toBe("local-workspace-resolve")
    expect(routeFamilyFor("/api/workspace/:id/user-hosted/register")?.id).toBe("workspace-authority")
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
      "/api/claxedo/agent-config/extensions",
      "/api/claxedo/agent-config/extensions/:id",
      "/api/claxedo/agent-config/extensions/:id/disable",
      "/api/claxedo/agent-config/extensions/:id/enable",
      "/api/claxedo/agent-config/extensions/:id/update",
      "/api/claxedo/agent-config/extensions/adopt",
      "/api/claxedo/agent-config/extensions/catalog",
      "/api/claxedo/agent-config/extensions/detach",
      "/api/claxedo/agent-config/extensions/ignore",
      "/api/claxedo/agent-config/extensions/machine-scan",
      "/api/claxedo/agent-config/extensions/scan",
      "/api/claxedo/agent-config/harness",
      "/api/claxedo/agent-config/harness/acp-connections",
      "/api/claxedo/agent-config/harness/acp-connections/:id",
      "/api/claxedo/agent-config/harness/model",
      "/api/claxedo/agent-config/harness/options",
      "/api/claxedo/agent-config/mcp",
      "/api/claxedo/agent-config/mcp/:name",
      "/api/claxedo/agent-config/runner/options",
      "/api/claxedo/bootstrap",
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/*",
      "/api/claxedo/credentials/:id",
      "/api/claxedo/credentials/:id/scope",
      "/api/claxedo/credentials/:id/status",
      "/api/claxedo/credentials/:id/verify",
      "/api/claxedo/credentials/:providerId",
      "/api/claxedo/credentials/discover",
      "/api/claxedo/credentials/provider/:providerId",
      "/api/claxedo/credentials/save-discovered",
      "/api/claxedo/credentials/sync-local",
      "/api/claxedo/events",
      "/api/claxedo/health",
      "/api/claxedo/network-policy",
      "/api/claxedo/network-policy/:id",
      "/api/claxedo/network-policy/check",
      "/api/claxedo/network-policy/effective/:workspaceId",
      "/api/claxedo/network-policy/groups",
      "/api/claxedo/session",
      "/api/claxedo/session-list",
      "/api/claxedo/session/:id/meta",
      "/api/claxedo/track",
      "/api/claxedo/workspace",
      "/api/claxedo/workspace/resolve",
      "/api/control",
      "/api/control/*",
      "/api/control/runtime/heartbeat",
      "/api/control/runtime/register",
      "/api/control/session-list",
      "/api/control/session/:id/runtime-events",
      "/api/control/sessions",
      "/api/control/sessions/:sessionId/capabilities",
      "/api/control/sessions/:sessionId/gateway",
      "/api/control/sessions/:sessionId/messages",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
      "/api/wr/events",
      "/api/wr/pty/:ptyID/connect",
      "/api/wr/runtime-events",
      "/auth/:providerID",
      "/command",
      "/config",
      "/config/providers",
      "/experimental/worktree",
      "/experimental/worktree/reset",
      "/file",
      "/file/all",
      "/file/content",
      "/file/status",
      "/find",
      "/find/file",
      "/find/symbol",
      "/global/config",
      "/global/dispose",
      "/global/event",
      "/global/health",
      "/lsp",
      "/mcp",
      "/mcp/:name/connect",
      "/mcp/:name/disconnect",
      "/path",
      "/project",
      "/project/:id",
      "/project/current",
      "/provider",
      "/provider/*",
      "/provider/:providerID/oauth/:step",
      "/provider/:providerId/oauth/*",
      "/provider/:providerId/oauth/authorize",
      "/provider/:providerId/oauth/callback",
      "/provider/auth",
      "/question",
      "/session/status",
      "/vcs",
      "/workspaces/:workspaceId",
      "/workspaces/:workspaceId/*",
      "/workspaces/:workspaceId/api/wr/pty/:ptyID/connect",
    ])
  })

  test("records the hosted capabilities the local composition must lose", () => {
    // Not aspiration — this is the exact list Units 5 to 8 remove from the
    // desktop-local closure. Shrinking it is the measurable outcome of the
    // split, so it is asserted rather than described in prose.
    expect(pathsByOwner(localApp().routes, "server")).toEqual([
      "/.well-known/jwks.json",
      "/api/channels/discord",
      "/api/channels/discord/*",
      "/api/channels/fake",
      "/api/channels/github",
      "/api/channels/github/*",
      "/api/channels/pairing",
      "/api/channels/pairing/approve",
      "/api/channels/slack",
      "/api/channels/slack/*",
      "/api/channels/telegram",
      "/api/channels/telegram/*",
      "/api/channels/whatsapp",
      "/api/channels/whatsapp/*",
      "/api/claxedo/integrations",
      "/api/claxedo/integrations/:id/connect",
      "/api/claxedo/integrations/attempts/:state",
      "/api/claxedo/integrations/callback",
      "/api/claxedo/integrations/connections/:id",
      "/api/claxedo/integrations/connections/:id/auth-failure",
      "/api/claxedo/integrations/connections/:id/repositories",
      "/api/claxedo/integrations/connections/:id/reverify",
      "/api/claxedo/integrations/connections/:id/token",
      "/api/claxedo/integrations/connections/:id/webhook-secret",
      "/api/claxedo/project/remote",
      "/api/workspace",
      "/api/workspace/:id",
      "/api/workspace/:id/checkpoints",
      "/api/workspace/:id/checkpoints/:checkpointId/restore",
      "/api/workspace/:id/connection",
      "/api/workspace/:id/connection/refresh",
      "/api/workspace/:id/lifecycle/:operation",
      "/api/workspace/:id/shares",
      "/api/workspace/:id/user-hosted/heartbeat",
      "/api/workspace/:id/user-hosted/pause",
      "/api/workspace/:id/user-hosted/register",
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
      "/internal/relay/revocation",
      "/internal/relay/target",
    ])
  })

  test("records the machine-publication routes Host Connector takes over", () => {
    expect(pathsByOwner(localApp().routes, "host-connector")).toEqual([
      "/api/claxedo/remote-access",
      "/api/claxedo/remote-access/devices",
      "/api/claxedo/remote-access/devices/:hostId",
      "/api/claxedo/remote-access/enable",
      "/api/claxedo/remote-access/workspaces/:workspaceId/second-device-open",
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

  test("resolves the profile root from the product data directory, not the package location", async () => {
    // K7: a package move must not relocate durable state. The data root is
    // taken from the product/user directory, so the same env var still selects
    // the same profile after `deployments/local` becomes `@claxedo/local-server`.
    const { dataDir: resolveDataDir } = await import("@claxedo/server-core/platform/runtime/lib/paths")
    expect(resolveDataDir()).toBe(dataDir)
  })
})
