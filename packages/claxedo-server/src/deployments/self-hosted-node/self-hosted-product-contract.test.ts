import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { createSelfHostedApp } from "./app"
import { createHostedApp } from "../hosted-shared/hosted-app"
import { createControlPlaneServices, type ControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"
import { mountedPaths } from "@claxedo/server-core/deployments/product-route-families"

/**
 * Self-hosted single-binary product contract.
 *
 * This is a DIFFERENT product from the desktop-local server, even though today
 * both are `createSelfHostedApp`. It is the signed, internet-reachable, SQLite-backed
 * control plane that `bun run start` and the Docker image ship: embedded auth,
 * hosted WorkGraph and Documents, channels, Relay authority, and an optional
 * static web UI.
 *
 * Unit 7 asked whether it could be recomposed over the shared signed route
 * core. Measured at the mount level the answer is that it already is, for the
 * four route families the two compositions genuinely share, and that the rest
 * of the overlap below is same-path/different-implementation — see the note on
 * `SHARED_WITH_HOSTED_CORE`. So the partition is not a migration plan any
 * more; it is the record of which capabilities the two products answer at the
 * same address, and it fails when one of them silently stops.
 *
 * The partition is derived from the two real apps rather than hand-listed, so
 * it cannot drift from what the code actually mounts; the committed lists are
 * what make a change to that partition visible in review.
 */

let dataDir: string
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-contract-"))
  setEnv("CLAXEDO_DATA_DIR", dataDir)
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function selfHostedApp() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { authority: testManagedSessionAuthority(), localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
  ).app
}

function hostedCorePaths() {
  const managedSessionAuthority = testManagedSessionAuthority()
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(),
    },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(),
      usersMe: vi.fn(),
      listWorkspaces: vi.fn(),
      auditAllow: vi.fn(),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  const plane = {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: durableCliSessionTokenRegistry().registry,
    privateSessionAuthority: managedSessionAuthority,
    runtimeSessionAuthority: managedSessionAuthority,
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
    },
  } as unknown as HostedControlPlane

  return new Set((createHostedApp(plane) as unknown as Hono).routes.map((route) => route.path))
}

/**
 * Paths the self-hosted app and the cloud-hosted core both answer.
 *
 * A SHARED PATH, not a shared implementation — the distinction is the whole
 * point of this list and an earlier version of this comment got it wrong by
 * saying Unit 7 "must obtain every one of these from
 * `createSignedControlPlaneApp`". Measured at the mount level, the two
 * compositions overlap on five prefixes (`/`, `/api/workspace`, `/documents`,
 * `/api/control`, `/api/claxedo/integrations`) and mount the SAME route factory
 * for exactly four families:
 *
 *   JwksRoutes                  authority/routes/jwks
 *   InternalRelayResolverRoutes deployments/shared-routes/internal-relay
 *   WorkspaceCheckpointRoutes   workspace/routes/checkpoints
 *   DocumentsRoutes             documents/routes/index
 *
 * All four already live in one module that both compositions import, so there
 * is nothing left to move — and even those four are composed with different
 * options, because the options are where the posture lives (self-host passes
 * `allowUnsignedLocal: true` to the checkpoint routes and a local disk backend
 * to Documents; cloud passes neither).
 *
 * Everything else on this list is the same path answered by a DIFFERENT route
 * object: `/api/workspace/*` is `WorkspaceRoutes` here and
 * `HostedWorkspaceRoutes` there, `/api/control/*` is `ControlPlaneHttpRoutes`
 * vs `HostedControlRoutes`, `/project`/`/provider`/`/global/*` are the real
 * local surfaces vs `HostedShellRoutes`' hosted stubs. Merging any of those
 * would not remove a duplicate, it would delete one of two products.
 *
 * What the list is still good for: if a path drops off it, self-hosted quietly
 * lost a capability that cloud-hosted kept.
 *
 * Eight paths moved here from `SELF_HOSTED_NODE_ADAPTERS` on the Cloudflare
 * multiplayer migration branch, once `HostedShellRoutes`
 * (`routes/hosted/shell.ts`) and `hosted-core-app.ts` grew the same address
 * self-hosted already answered: the harness status/ACP-connections probe
 * every session's harness store polls, the owner's remote-access
 * status/devices/revoke/second-device surface (`RemoteAccessOwnerRoutes` in
 * `routes/remote-access.ts`, composed with `hostedRemoteAccessService`), the
 * unified `/api/control/session-list` read, and the single-project lookup at
 * `/project/:id`. Same DIFFERENT-implementation rule as the rest of this
 * list applies to all eight.
 */
const SHARED_WITH_HOSTED_CORE = [
  "/.well-known/jwks.json",
  "/api/claxedo/agent-config/extensions",
  "/api/claxedo/agent-config/extensions/:id",
  "/api/claxedo/agent-config/extensions/:id/disable",
  "/api/claxedo/agent-config/extensions/:id/enable",
  "/api/claxedo/agent-config/extensions/catalog",
  "/api/claxedo/agent-config/extensions/machine-scan",
  "/api/claxedo/agent-config/harness",
  "/api/claxedo/agent-config/harness/acp-connections",
  "/api/claxedo/events",
  "/api/claxedo/health",
  "/api/claxedo/integrations",
  "/api/claxedo/remote-access",
  "/api/claxedo/remote-access/devices",
  "/api/claxedo/remote-access/devices/:hostId",
  "/api/claxedo/remote-access/workspaces/:workspaceId/second-device-open",
  "/api/control/orgs",
  "/api/control/orgs/:orgId/ensure-default-team",
  "/api/control/orgs/:orgId/teams",
  "/api/control/runtime/heartbeat",
  "/api/control/runtime/register",
  "/api/control/session-list",
  "/api/control/session-registrations/reserve",
  "/api/control/sessions",
  "/api/control/sessions/:sessionId/gateway",
  "/api/control/sessions/:sessionId/messages",
  "/api/control/sessions/:sessionId/participants",
  "/api/control/sessions/:sessionId/shares",
  "/api/control/teams/:teamId/members",
  "/api/control/teams/:teamId/projects",
  "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
  "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
  "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
  "/api/runtime-authority/session-authorize",
  "/api/workspace",
  "/api/workspace/:id/checkpoints",
  "/api/workspace/:id/checkpoints/:checkpointId/restore",
  "/api/workspace/:id/connection",
  "/api/workspace/:id/connection/refresh",
  "/api/workspace/:id/host-assignment",
  "/api/workspace/:id/lifecycle/:operation",
  "/api/workspace/create",
  "/api/workspace/resolve",
  "/api/wr/events",
  "/auth/:providerID",
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
  "/global/event",
  "/global/health",
  "/internal/relay/*",
  "/internal/relay/revocation",
  "/internal/relay/target",
  "/path",
  "/project",
  "/project/:id",
  "/project/current",
  "/provider",
  "/provider/auth",
]

/**
 * Routes only the self-hosted Node deployment mounts.
 *
 * These are the adapters `createSelfHostedApp` supplies on top of the shared
 * core: local execution through Workspace Runtime, local credentials and
 * config, channels ingress, the local Documents broker, and network policy.
 * Unit 5 moves the local-execution subset behind
 * `@claxedo/local-server/self-hosted-execution`; the rest stays in server.
 */
const SELF_HOSTED_NODE_ADAPTERS = [
  "/agent",
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
  "/api/claxedo/agent-config",
  "/api/claxedo/agent-config/agents",
  "/api/claxedo/agent-config/commands",
  "/api/claxedo/agent-config/commands/:name",
  "/api/claxedo/agent-config/extensions/:id/update",
  "/api/claxedo/agent-config/extensions/adopt",
  "/api/claxedo/agent-config/extensions/detach",
  "/api/claxedo/agent-config/extensions/ignore",
  "/api/claxedo/agent-config/extensions/scan",
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
  "/api/claxedo/integrations/:id/connect",
  "/api/claxedo/integrations/attempts/:state",
  "/api/claxedo/integrations/callback",
  "/api/claxedo/integrations/connections/:id",
  "/api/claxedo/integrations/connections/:id/auth-failure",
  "/api/claxedo/integrations/connections/:id/repositories",
  "/api/claxedo/integrations/connections/:id/reverify",
  "/api/claxedo/integrations/connections/:id/token",
  "/api/claxedo/integrations/connections/:id/webhook-secret",
  "/api/claxedo/network-policy",
  "/api/claxedo/network-policy/:id",
  "/api/claxedo/network-policy/check",
  "/api/claxedo/network-policy/effective/:workspaceId",
  "/api/claxedo/network-policy/groups",
  "/api/claxedo/project/remote",
  "/api/claxedo/remote-access/enable",
  "/api/claxedo/session",
  "/api/claxedo/session-list",
  "/api/claxedo/session/:id/meta",
  "/api/claxedo/track",
  "/api/claxedo/workspace",
  "/api/claxedo/workspace/resolve",
  "/api/control",
  "/api/control/*",
  "/api/control/session/:id/runtime-events",
  "/api/control/sessions/:sessionId/capabilities",
  "/api/workspace/:id",
  "/api/workspace/:id/shares",
  "/api/workspace/drivers",
  "/api/workspace/drivers/:id/auth",
  "/api/workspace/drivers/default",
  "/api/wr/pty/:ptyID/connect",
  "/api/wr/runtime-events",
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
  "/internal/documents/*",
  "/internal/documents/:id",
  "/internal/documents/index",
  "/internal/documents/jobs/activate",
  "/internal/documents/jobs/revoke",
  "/lsp",
  "/mcp",
  "/mcp/:name/connect",
  "/mcp/:name/disconnect",
  "/provider/*",
  "/provider/:providerID/oauth/:step",
  "/provider/:providerId/oauth/*",
  "/provider/:providerId/oauth/authorize",
  "/provider/:providerId/oauth/callback",
  "/question",
  "/session/status",
  "/vcs",
  "/workspaces/:workspaceId",
  "/workspaces/:workspaceId/*",
  "/workspaces/:workspaceId/api/wr/pty/:ptyID/connect",
]

describe("self-hosted composition partition", () => {
  test("shares exactly the recorded route set with the hosted core", () => {
    const core = hostedCorePaths()
    expect(mountedPaths(selfHostedApp().routes).filter((path) => core.has(path))).toEqual(SHARED_WITH_HOSTED_CORE)
  })

  test("supplies exactly the recorded self-hosted Node adapter routes", () => {
    const core = hostedCorePaths()
    expect(mountedPaths(selfHostedApp().routes).filter((path) => !core.has(path))).toEqual(SELF_HOSTED_NODE_ADAPTERS)
  })

  test("the partition covers every mounted route exactly once", () => {
    const partition = [...SHARED_WITH_HOSTED_CORE, ...SELF_HOSTED_NODE_ADAPTERS]
    expect(partition).toEqual([...new Set(partition)])
    expect(partition.toSorted()).toEqual(mountedPaths(selfHostedApp().routes))
  })
})

describe("self-hosted product behaviour", () => {
  test("serves the container health contract", async () => {
    const response = await selfHostedApp().request("/api/claxedo/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, localExecution: true })
  })

  test("mounts the embedded auth issuer only when embedded auth is enabled", async () => {
    expect(mountedPaths(selfHostedApp().routes)).not.toContain("/api/auth/*")

    setEnv("CLAXEDO_EMBEDDED_AUTH", "1")
    expect(mountedPaths(selfHostedApp().routes)).toContain("/api/auth/*")

    // Composing the app starts better-auth's schema migration against a SQLite
    // file under this test's temp data dir. `afterEach` deletes that dir, so
    // without waiting the migration finishes against a removed file and raises
    // an unhandled SQLITE_IOERR — attributed to whichever test happens to be
    // running when it lands, which is a genuinely miserable thing to debug.
    const { getEmbeddedAuth, resetEmbeddedAuthForTests } = await import("./embedded-auth")
    await getEmbeddedAuth().ready.catch(() => {})
    resetEmbeddedAuthForTests()
  })

  test("mounts the static web UI only when a built bundle is configured", async () => {
    const withoutBundle = await selfHostedApp().request("/")
    expect(withoutBundle.status).not.toBe(200)

    const dist = path.join(dataDir, "app-dist")
    mkdirSync(dist, { recursive: true })
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>self-host</title>")
    setEnv("CLAXEDO_APP_DIST_DIR", dist)

    const withBundle = selfHostedApp()
    const response = await withBundle.request("/")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("self-host")
  })

  test("warns and stays up when the configured bundle has no index.html", async () => {
    const dist = path.join(dataDir, "empty-dist")
    mkdirSync(dist, { recursive: true })
    setEnv("CLAXEDO_APP_DIST_DIR", dist)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const health = await selfHostedApp().request("/api/claxedo/health")
      expect(health.status).toBe(200)
    } finally {
      warn.mockRestore()
    }
  })

  test("keeps its data root in the product data directory, not the package directory", async () => {
    const { dataDir: resolveDataDir, stateDir } = await import("@claxedo/server-core/platform/runtime/lib/paths")
    expect(resolveDataDir()).toBe(dataDir)
    expect(stateDir()).toContain(dataDir)
  })
})
