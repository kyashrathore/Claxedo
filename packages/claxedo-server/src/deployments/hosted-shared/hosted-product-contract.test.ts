import { describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { createHostedApp } from "./hosted-app"
import {
  HostedWorkerCompositionError,
  sandboxRelayTargetLookup,
  type HostedControlPlane,
} from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"

/**
 * Hosted product contract.
 *
 * `hosted-app.test.ts` covers hosted BEHAVIOUR in depth — auth, authority,
 * sandbox, relay, billing. What it does not do is state the hosted route
 * inventory as one closed set, and that is precisely what the split needs.
 *
 * Unit 7 extracts `createSignedControlPlaneApp` out of `createHostedApp`, and
 * Unit 8 rewires cloud Node, workerd, and self-hosted Node onto it. Each of
 * those steps can silently drop a route family: the extraction compiles, the
 * behaviour tests that happen to exist still pass, and a hosted deployment
 * quietly stops serving billing or device auth. This file makes the inventory
 * itself the assertion, so a dropped family fails at the boundary rather than
 * in production.
 *
 * It also records the NEGATIVE half — the desktop-local families that must
 * never appear in a hosted app. That direction protects the opposite mistake:
 * Unit 7 recomposing self-hosted by pulling local execution into the shared
 * hosted core, which would put PTY and credential routes on the cloud plane.
 */

function hostedPlane(): HostedControlPlane {
  const managedSessionAuthority = testManagedSessionAuthority()
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(async () => {
        throw new Error("the inventory contract never authenticates")
      }),
    },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org_1"),
      usersMe: vi.fn(async () => ({ id: "u", user_id: "u" })),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  return {
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
}

function hostedPaths() {
  const app = createHostedApp(hostedPlane()) as unknown as Hono
  return [...new Set(app.routes.map((route) => route.path))]
    .filter((path) => path !== "/*" && path !== "*")
    .toSorted()
}

/**
 * Route families the hosted control plane owns. Grouped by capability so a
 * failure names the product area that changed, not just a path.
 */
const HOSTED_FAMILIES: Record<string, string[]> = {
  remoteAccessOwner: [
    "/api/claxedo/remote-access",
    "/api/claxedo/remote-access/devices",
    "/api/claxedo/remote-access/devices/:hostId",
    "/api/claxedo/remote-access/workspaces/:workspaceId/second-device-open",
  ],
  identity: [
    "/.well-known/jwks.json",
    "/api/auth/cli/exchange",
    "/api/auth/cli/revoke",
    "/api/auth/device/code",
    "/api/auth/device/token",
    "/api/claxedo/auth/descriptor",
    "/auth/:providerID",
  ],
  shell: [
    "/api/claxedo/bootstrap",
    "/api/claxedo/compatibility",
    "/api/claxedo/events",
    "/api/claxedo/health",
    "/api/claxedo/mode",
    "/global/config",
    "/global/event",
    "/global/health",
    "/path",
    "/project",
    "/project/current",
    "/project/:id",
    "/provider",
    "/provider/auth",
    "/api/claxedo/agent-config/extensions",
    "/api/claxedo/agent-config/extensions/:id",
    "/api/claxedo/agent-config/extensions/:id/disable",
    "/api/claxedo/agent-config/extensions/:id/enable",
    "/api/claxedo/agent-config/extensions/catalog",
    "/api/claxedo/agent-config/extensions/machine-scan",
    "/api/claxedo/agent-config/harness",
    "/api/claxedo/agent-config/harness/acp-connections",
  ],
  // Unified usage dashboard/sync, mounted only when the plane has a Convex
  // workspace-authority binding to build a ledger from (`hostedUsageLedger`
  // in `hosted-usage-ledger.ts`) — this fixture's plane does.
  usage: ["/api/claxedo/usage", "/api/claxedo/usage/sync"],
  billing: ["/api/billing/checkout", "/api/billing/polar/webhook", "/api/billing/portal"],
  connections: ["/api/claxedo/integrations", "/api/claxedo/integrations/*"],
  sessions: [
    "/api/control/runtime/heartbeat",
    "/api/control/runtime/register",
    "/api/control/session-registrations/reserve",
    "/api/control/session-list",
    "/api/control/sessions",
    "/api/control/sessions/:sessionId/gateway",
    "/api/control/sessions/:sessionId/messages",
    "/api/control/sessions/:sessionId/participants",
    "/api/control/sessions/:sessionId/shares",
    "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
    "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
    "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
    "/api/runtime-authority/session-authorize",
    "/api/wr/events",
  ],
  /**
   * Application-owned Org → Team nesting (D17–D19): create/list orgs and
   * nested teams, members, and project grants. Distinct from Clerk Organizations.
   */
  orgTeams: [
    "/api/control/orgs",
    "/api/control/orgs/:orgId/ensure-default-team",
    "/api/control/orgs/:orgId/teams",
    "/api/control/teams/:teamId/members",
    "/api/control/teams/:teamId/projects",
  ],
  workgraph: [
    "/api/workgraph",
    "/api/workgraph/*",
    "/internal/workgraph/connection-operation",
    "/internal/workgraph/reconcile",
    "/internal/workgraph/run-operation",
  ],
  documents: [
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
  ],
  workspaceAuthority: [
    "/api/workspace",
    "/api/workspace/:id/checkpoints",
    "/api/workspace/:id/checkpoints/:checkpointId/restore",
    "/api/workspace/:id/connection",
    "/api/workspace/:id/connection/refresh",
    // Owner assignment under machine-wide enrollment (POST assigns, DELETE
    // unassigns — one path, two verbs). The replacement for the retired
    // per-workspace `user-hosted/(challenge|register|heartbeat|pause)` quartet.
    "/api/workspace/:id/host-assignment",
    "/api/workspace/:id/lifecycle/:operation",
    "/api/workspace/create",
    "/api/workspace/resolve",
  ],
  /**
   * Machine-wide enrollment, Unit 6's replacement for the retired
   * per-workspace `userHostedControl` family. The cutover is complete: the
   * old quartet is gone (see the 404 assertions below) and this family plus
   * `host-assignment` above are what replaced it.
   *
   * No `:id` in any entry. That is the whole difference.
   */
  hostEnrollment: [
    "/api/claxedo/host/enrollments",
    "/api/claxedo/host/enrollments/heartbeat",
    "/api/claxedo/host/enrollments/pause",
    "/api/claxedo/host/enrollments/requests",
  ],
  relayResolver: ["/internal/relay/*", "/internal/relay/revocation", "/internal/relay/target"],
  sandboxAdmin: ["/internal/sandbox-manager/*", "/internal/sandbox-manager/gc", "/internal/sandbox-manager/release"],
}

/**
 * Desktop-local capabilities that must never reach a hosted app. Prefixes, so
 * a newly mounted `/api/claxedo/credentials/whatever` is caught too.
 */
const LOCAL_ONLY_PREFIXES = [
  "/api/claxedo/credentials",
  "/api/claxedo/remote-access/enable",
  "/api/claxedo/network-policy",
  "/api/claxedo/usage-limits",
  "/api/wr/pty",
  "/workspaces/:workspaceId",
  "/experimental/worktree",
  "/file",
  "/find",
  "/lsp",
  "/vcs",
  "/mcp",
  "/command",
  "/question",
  "/session/status",
  "/config",
  "/global/dispose",
]

describe("hosted product contract", () => {
  test("mounts exactly the declared hosted route families", () => {
    expect(hostedPaths()).toEqual(Object.values(HOSTED_FAMILIES).flat().toSorted())
  })

  for (const [family, paths] of Object.entries(HOSTED_FAMILIES)) {
    test(`retains the ${family} routes`, () => {
      const mounted = new Set(hostedPaths())
      expect(paths.filter((path) => !mounted.has(path))).toEqual([])
    })
  }

  test("mounts no desktop-local capability", () => {
    expect(
      hostedPaths().filter((path) => LOCAL_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))),
    ).toEqual([])
  })

  test("the retired per-workspace user-hosted quartet answers 404, not a handler", async () => {
    // NO backward compatibility: machine-wide enrollment + owner assignment
    // replaced the per-workspace challenge/register/heartbeat/pause flow. A
    // 401/400/409 here would mean a handler still exists behind the path.
    const app = createHostedApp(hostedPlane()) as unknown as Hono
    for (const retired of ["challenge", "register", "heartbeat", "pause"]) {
      const response = await app.request(`/api/workspace/ws_1/user-hosted/${retired}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status, `POST /api/workspace/ws_1/user-hosted/${retired}`).toBe(404)
    }
  })

  /**
   * K5 pins these three assertions in place: Unit 7 extracts the shared signed
   * route core OUT of `createHostedApp`, and the tempting shortcut is to let
   * self-hosted Node reuse `createHostedApp` by loosening whichever check it
   * fails. That would hand a self-hosted posture the cloud boot contract.
   * `createHostedApp` must keep failing closed on all three.
   */
  test("refuses to boot outside hosted deployment mode", () => {
    const plane = hostedPlane()
    ;(plane as unknown as { env: Record<string, string> }).env = {
      ...plane.env,
      CLAXEDO_DEPLOYMENT_MODE: "local",
    }
    expect(() => createHostedApp(plane)).toThrow(HostedWorkerCompositionError)
    expect(() => createHostedApp(plane)).toThrow(/deployment mode is not hosted/)
  })

  test("refuses to boot without signed auth", () => {
    const plane = hostedPlane()
    ;(plane.services.auth as unknown as { config: { enabled: boolean } }).config = { enabled: false }
    expect(() => createHostedApp(plane)).toThrow(/signed auth is not enabled/)
  })

  test("refuses to boot without a composed workspace authority", () => {
    const plane = hostedPlane()
    ;(plane.services as unknown as { authority: undefined }).authority = undefined
    expect(() => createHostedApp(plane)).toThrow(/no workspace authority is composed/)
  })
})

/**
 * `/api/claxedo/usage` gating (`hosted-usage-ledger.ts`).
 *
 * The route table assertion above already proves the paths mount for THIS
 * fixture's plane (which carries both Convex bindings). These two cases prove
 * the two things the table can't: the auth gate is real, and a plane missing
 * either binding gets no route at all rather than one that would 503 on
 * every call.
 */
describe("hosted usage route", () => {
  test("requires signed auth", async () => {
    const app = createHostedApp(hostedPlane()) as unknown as Hono
    const res = await app.request("/api/claxedo/usage?since=0&until=1")
    expect(res.status).toBe(401)
  })

  test("stays unmounted for a plane with no Convex workspace-authority URL", async () => {
    const plane = hostedPlane()
    ;(plane as unknown as { env: Record<string, string | undefined> }).env = {
      ...plane.env,
      CLAXEDO_WORKSPACE_AUTHORITY_URL: undefined,
    }
    // Hosted WorkGraph independently requires this same URL (or an injected
    // executor) to boot at all; supply the test executor seam so the app
    // still composes and this test exercises `hostedUsageLedger`'s own gate,
    // not WorkGraph's.
    const app = createHostedApp(plane, { workGraphExecutor: {} as never }) as unknown as Hono
    expect([...new Set(app.routes.map((route) => route.path))]).not.toContain("/api/claxedo/usage")
    const res = await app.request("/api/claxedo/usage?since=0&until=1")
    expect(res.status).toBe(404)
  })
})
