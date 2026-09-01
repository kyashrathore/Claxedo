/**
 * `GET /api/claxedo/agent-config/harness` on the hosted shell surface
 * (routes/hosted/shell.ts) — the harness health/status probe.
 *
 * The app's harness store polls this UNCONDITIONALLY for every session on
 * every deployment kind (`features/session/harness/{harness-config-store,
 * harness-switcher,harness-hydrator}.ts`, all three fetch it with a bare
 * `GET`). Before this route existed the hosted central had no such path, so
 * every probe 404'd, the failure was swallowed by the callers' own
 * `.catch(() => undefined)`, and a session's harness readiness never moved
 * off its initial state.
 *
 * Two layers are covered:
 *
 *   1. the ROUTE (`HostedShellRoutes`) against a stubbed `harnessStatus`
 *      callback — auth gating, workspace-ref parsing, and response shaping;
 *   2. the PRODUCTION callback (`hostedHarnessRuntimeStatus`) against a fake
 *      `ControlPlaneServices` + the `runtimeFetch` test seam on
 *      `verifiedRuntimeJson` — so a regression in the actual relay call (not
 *      just the route's response shaping) fails a test here too.
 */
import { describe, expect, test, vi } from "vitest"
import { HostedShellRoutes, hostedHarnessRuntimeStatus, type HostedHarnessProbe } from "./shell"
import type { ControlPlaneAuthConfig, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const verifier = async (token: string) => {
  if (token !== "token-a") throw Object.assign(new Error("unknown token"), { status: 401 })
  return {
    mode: "signed" as const,
    user: {
      subject: "user_a",
      tokenIdentifier: `${signedConfig.issuer}|user_a`,
      issuer: signedConfig.issuer,
      orgId: "org_a",
    },
  }
}

function get(app: ReturnType<typeof HostedShellRoutes>, path: string, token?: string) {
  return app.request(`http://cp.test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe("GET /api/claxedo/agent-config/harness — auth and workspace resolution", () => {
  test("no Authorization header is 401 and never reaches harnessStatus", async () => {
    const harnessStatus = vi.fn()
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, "/api/claxedo/agent-config/harness?directory=workspace:ws_1")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(harnessStatus).not.toHaveBeenCalled()
  })

  test("an unverifiable bearer is 401", async () => {
    const harnessStatus = vi.fn()
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, "/api/claxedo/agent-config/harness?directory=workspace:ws_1", "forged")
    expect(res.status).toBe(401)
    expect(harnessStatus).not.toHaveBeenCalled()
  })

  test("a composition with no harnessStatus wired answers 404, not a bare unmatched-route 404", async () => {
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier })
    const res = await get(app, "/api/claxedo/agent-config/harness?directory=workspace:ws_1", "token-a")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_not_found" } })
  })

  test("harnessStatus resolving to undefined (workspace the caller cannot open) is 404", async () => {
    const harnessStatus = vi.fn(async () => undefined)
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, "/api/claxedo/agent-config/harness?directory=workspace:ws_1", "token-a")
    expect(res.status).toBe(404)
    expect(harnessStatus).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed" }),
      { workspaceId: "ws_1" },
    )
  })

  test.each([
    ["a bare uuid workspaceId ref", "workspace:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"],
    ["a bare ws_ id with no workspace: prefix", "ws_abc123", "ws_abc123"],
  ])("accepts %s", async (_label, directory, expected) => {
    const harnessStatus = vi.fn(async () => ({ ok: true }) satisfies HostedHarnessProbe)
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, `/api/claxedo/agent-config/harness?directory=${encodeURIComponent(directory)}`, "token-a")
    expect(res.status).toBe(200)
    expect(harnessStatus).toHaveBeenCalledWith(expect.anything(), { workspaceId: expected })
  })

  test.each([
    ["a filesystem path", "/Users/me/repo"],
    ["an empty directory", ""],
    ["a directory with no workspace shape", "not-a-workspace-ref"],
  ])("%s never reaches harnessStatus and answers 404", async (_label, directory) => {
    const harnessStatus = vi.fn()
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, `/api/claxedo/agent-config/harness?directory=${encodeURIComponent(directory)}`, "token-a")
    expect(res.status).toBe(404)
    expect(harnessStatus).not.toHaveBeenCalled()
  })

  test("sessionId is forwarded and echoed back on a ready probe", async () => {
    const harnessStatus = vi.fn(async () => ({
      ok: true,
      agentType: "claude",
      acpBinary: null,
      harnessHealth: { status: "ok" as const },
    }) satisfies HostedHarnessProbe)
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(
      app,
      "/api/claxedo/agent-config/harness?directory=workspace:ws_1&sessionId=ses_42",
      "token-a",
    )
    expect(res.status).toBe(200)
    expect(harnessStatus).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_1", sessionId: "ses_42" })
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      workspaceId: "ws_1",
      directory: "workspace:ws_1",
      sessionId: "ses_42",
      status: "ready",
      ready: true,
      agentType: "claude",
      activeType: "claude",
      activeBinary: null,
      harnessHealth: { status: "ok" },
    })
  })

  test("a degraded probe (runtime unreachable) reports status/ready/error without failing the request", async () => {
    const harnessStatus = vi.fn(async () => ({
      ok: false,
      status: "error",
      error: "workspace runtime pull failed: 503",
    }) satisfies HostedHarnessProbe)
    const app = HostedShellRoutes({ authConfig: signedConfig, verifier, harnessStatus })
    const res = await get(app, "/api/claxedo/agent-config/harness?directory=workspace:ws_1", "token-a")
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      status: "error",
      ready: false,
      error: "workspace runtime pull failed: 503",
      activeBinary: null,
    })
    expect(body.agentType).toBeUndefined()
  })
})

// --- Production callback: hostedHarnessRuntimeStatus -----------------------

const signed: SignedControlPlaneAuth = {
  mode: "signed",
  token: "user_1",
  user: {
    subject: "user_1",
    tokenIdentifier: "issuer|user_1",
    issuer: "issuer",
    orgId: "org_1",
  },
}

function fakeServices(authority: Partial<WorkspaceAuthority>): ControlPlaneServices {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: {} as never,
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() } as never,
    localExecution: { enabled: false },
    authority: authority as WorkspaceAuthority,
  }
}

describe("hostedHarnessRuntimeStatus — the production relay call", () => {
  test("resolves the workspace, verifies runtime identity, and shapes /api/wr/health", async () => {
    const openWorkspace = vi.fn(async () => ({
      role: "editor",
      workspace: { access: "user-hosted", backing: "local-worktree", org_id: "org_1" },
    }))
    const services = fakeServices({ openWorkspace: openWorkspace as never })
    const runtimeFetch = vi.fn(async (input: { path: string }) => {
      if (input.path === "/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      return Response.json({
        ok: true,
        status: "ready",
        agentType: "claude",
        acpBinary: null,
        model: null,
        harnessHealth: { status: "ok" },
      })
    })

    const harnessStatus = hostedHarnessRuntimeStatus(services, { runtimeFetch })
    const result = await harnessStatus(signed, { workspaceId: "ws_1", sessionId: "ses_1" })

    expect(result).toEqual({
      ok: true,
      status: "ready",
      agentType: "claude",
      acpBinary: null,
      model: null,
      harnessHealth: { status: "ok" },
    })
    // The health fetch carries the session id the caller asked about.
    const healthCall = runtimeFetch.mock.calls.find(([input]) => input.path.startsWith("/api/wr/health"))
    expect(healthCall?.[0].path).toBe("/api/wr/health?sessionId=ses_1")
    expect(openWorkspace).toHaveBeenCalledWith(signed, { workspaceId: "ws_1" })
  })

  test("a workspace the caller cannot open resolves to undefined, never calling the runtime", async () => {
    const runtimeFetch = vi.fn()
    const services = fakeServices({
      openWorkspace: vi.fn(async () => {
        const { ControlPlaneAuthError } = await import("@claxedo/server-core/platform/auth/auth")
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "denied")
      }) as never,
    })
    const harnessStatus = hostedHarnessRuntimeStatus(services, { runtimeFetch })
    const result = await harnessStatus(signed, { workspaceId: "ws_missing" })
    expect(result).toBeUndefined()
    expect(runtimeFetch).not.toHaveBeenCalled()
  })

  test("a runtime identity mismatch degrades to an error probe rather than throwing", async () => {
    const services = fakeServices({
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "user-hosted", backing: "local-worktree", org_id: "org_1" },
      })) as never,
    })
    // The relay answers for a DIFFERENT workspace than the one requested —
    // verifiedRuntimeJson's identity probe must catch this, not the health
    // shape decoder.
    const runtimeFetch = vi.fn(async () => Response.json({ workspaceId: "ws_other" }))
    const harnessStatus = hostedHarnessRuntimeStatus(services, { runtimeFetch })
    const result = await harnessStatus(signed, { workspaceId: "ws_1" })
    expect(result?.ok).toBe(false)
    expect(result?.status).toBe("error")
    expect(result?.error).toMatch(/workspace_runtime_mismatch|does not match/)
  })

  // Mutation-check: a caller with no relay-reachable role never gets a health
  // probe. Reproduced here as a first-class case (not just a manual
  // temporary break) so a future regression that drops this guard is caught.
  test("a role the relay does not recognize resolves to undefined", async () => {
    const runtimeFetch = vi.fn()
    const services = fakeServices({
      openWorkspace: vi.fn(async () => ({ role: "not-a-relay-role", workspace: {} })) as never,
    })
    const harnessStatus = hostedHarnessRuntimeStatus(services, { runtimeFetch })
    const result = await harnessStatus(signed, { workspaceId: "ws_1" })
    expect(result).toBeUndefined()
    expect(runtimeFetch).not.toHaveBeenCalled()
  })
})
