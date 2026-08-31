import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, localOnlyAuthAdapter, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../services"

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  updateWorkspace: vi.fn(async () => undefined),
}))
const originalFetch = globalThis.fetch
const signedAuth = {
  mode: "signed" as const,
  token: "user-token",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

const canonicalUsersMe = () => vi.fn(async () => ({
  actor_id: "actor_user_1",
  actor_kind: "human" as const,
}))

function stubFetch(fetch: unknown) {
  globalThis.fetch = fetch as typeof globalThis.fetch
}

function errorShape(err: unknown) {
  return err && typeof err === "object"
    ? {
        code: (err as { code?: unknown }).code,
        status: (err as { status?: unknown }).status,
      }
    : err
}

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
  updateWorkspace: mocks.updateWorkspace,
}))

import {
  ControlPlaneHttpRoutes,
  heartbeatControlRuntime,
  pullControlSession,
  pullControlSessionMessages,
  registerControlRuntime,
  resolveSessionGateway,
} from "../http"
import { assertRuntimeMutationAuth, runtimeSnapshotInput } from "./protocol"

function services(): ControlPlaneServices {
  let projectedMessages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async (_ws, _sessionId, messages) => {
        projectedMessages = messages as typeof projectedMessages
      }),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => projectedMessages),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
  }
}

describe("control plane HTTP protocol", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mocks.resolveWorkspace.mockClear()
    mocks.updateWorkspace.mockClear()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "starting",
    })
  })

  test("does not expose push session sync endpoints", async () => {
    const svc = services()
    const app = ControlPlaneHttpRoutes(svc)
    const routes = [
      ["POST", "/sessions/sync"],
      ["POST", "/sessions/sync-many"],
      ["POST", "/sessions/session-1/messages"],
      ["DELETE", "/sessions/session-1"],
    ] as const

    for (const [method, path] of routes) {
      const res = await app.request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_1" }),
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_metas).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })

  test("checkpoint waits for the active status to clear before admitting independent Session intake", async () => {
    const svc = services()
    const syncSessionMessages = vi.fn(async () => ({}))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({})),
      authorizeSessionWrite: vi.fn(async () => ({ allowed: true })),
      upsertSessionVisibility: vi.fn(async () => ({})),
      syncSessionMessages,
    } as never
    const auth = {
      mode: "signed" as const,
      token: "user_1",
      user: {
        subject: "user_1",
        tokenIdentifier: "issuer|user_1",
        issuer: "issuer",
      },
    }
    const messages = [
      {
        info: { id: "msg-1", role: "user" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { id: "msg-2", role: "assistant" },
        parts: [{ type: "text", text: "summary" }],
      },
    ]
    const statuses = [{ "session-1": { type: "busy" } }, {}]
    const payloads = [
      { messages, session: { id: "session-1", title: "Settled title" } },
      { messages: messages.slice(0, 1), maxEventOrdinal: 7, session: { id: "session-1", title: "Settled title" } },
    ]

    const pull = () =>
      pullControlSessionMessages(
        svc,
        {
          runtimeFetch: async (input: { path: string }) => {
            if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
            if (input.path === "/session/session-1/message?snapshot=1") {
              return Response.json(payloads.shift() ?? {
                messages,
                session: { id: "session-1", title: "Settled title" },
              })
            }
            if (input.path === "/session/status") return Response.json(statuses.shift() ?? {})
            return new Response("not found", { status: 404 })
          },
        },
        auth,
        {
          workspaceId: "ws_1",
          sessionId: "session-1",
        },
      )

    await pull()

    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
    )
    expect(syncSessionMessages).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "signed" }), {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages,
      maxEventOrdinal: 0,
      intakeReady: false,
    })

    vi.mocked(svc.projectionStore.read_session_messages).mockReturnValue(messages)
    vi.mocked(svc.projectionStore.read_session_max_event_ordinal).mockReturnValue(7)

    await expect(pull()).resolves.toMatchObject({ skipped: true, snapshotOrdinal: 7 })

    expect(syncSessionMessages).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
  })

  test("register and heartbeat delegate to workspace and sandbox manager state", async () => {
    const svc = services()
    const register = vi.fn(async () => ({ ok: true as const, status: "ready" as const }))
    const heartbeat = vi.fn(async () => ({ ok: true as const, status: "ready" as const }))
    svc.sandbox.sandboxManager = { register, heartbeat } as never
    const input = {
      workspaceId: "ws_1",
      ok: true,
      status: "ready",
      directory: "/tmp/demo",
      profile: "workspace",
      agentType: "opencode",
      model: "gpt-5.4",
      ptyCount: 1,
      processCount: 2,
      activeProcessCount: 1,
      url: "https://runtime.example.com",
      leaseId: "lease_1",
      sandboxId: "sandbox_1",
      epoch: 2,
    }

    await registerControlRuntime(svc, input)
    await heartbeatControlRuntime(svc, input)

    expect(mocks.updateWorkspace).toHaveBeenCalledWith("ws_1", { status: "ready" })
    expect(register).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({
        ok: true,
        status: "ready",
        url: "https://runtime.example.com",
        sandboxId: "sandbox_1",
        epoch: 2,
        active: true,
      }),
    )
    expect(heartbeat).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({
        ok: true,
        url: "https://runtime.example.com",
        sandboxId: "sandbox_1",
        epoch: 2,
        active: true,
      }),
    )
  })

  test("runtime mutations reject signed users and cross-workspace runtime tokens", () => {
    expect(() => assertRuntimeMutationAuth(
      new Request("http://localhost/runtime/register"),
      {
        mode: "signed",
        token: "user-token",
        user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
      },
      "ws_1",
    )).toThrow("Workspace runtime control token is required")

    expect(() => assertRuntimeMutationAuth(
      new Request("http://localhost/runtime/register", {
        headers: { "x-workspace-id": "ws_a" },
      }),
      { mode: "unsigned-local", reason: "workspace-runtime-control-token" },
      "ws_b",
    )).toThrow("Workspace runtime control token does not match")

    expect(() => assertRuntimeMutationAuth(
      new Request("http://localhost/runtime/register"),
      { mode: "unsigned-local", reason: "local control plane" },
      "ws_1",
    )).not.toThrow()
  })

  test("runtime snapshot schema rejects legacy runtimeUrl snapshots", () => {
    expect(() =>
      runtimeSnapshotInput.parse({
        workspaceId: "ws_1",
        ok: true,
        status: "ready",
        directory: "/tmp/demo",
        profile: "workspace",
        agentType: "opencode",
        model: "gpt-5.4",
        ptyCount: 0,
        processCount: 0,
        activeProcessCount: 0,
        runtimeUrl: "https://legacy-runtime.example.com",
        sandboxId: "sandbox_legacy",
        epoch: 7,
      }),
    ).toThrow()
  })

  test("register and heartbeat fail closed when no sandbox manager owns the lease", async () => {
    const svc = services()
    const input = {
      workspaceId: "ws_1",
      ok: true,
      status: "ready",
      directory: "/tmp/demo",
      profile: "workspace",
      agentType: "opencode",
      model: "gpt-5.4",
      ptyCount: 0,
      processCount: 0,
      activeProcessCount: 0,
      url: "https://runtime.example.com",
      sandboxId: "sandbox_1",
      epoch: 2,
    }

    await expect(registerControlRuntime(svc, input).catch(errorShape)).resolves.toEqual({
      code: "sandbox_manager_unavailable",
      status: 503,
    })
    await expect(heartbeatControlRuntime(svc, input).catch(errorShape)).resolves.toEqual({
      code: "sandbox_manager_unavailable",
      status: 503,
    })
    expect(mocks.updateWorkspace).not.toHaveBeenCalled()

    const app = ControlPlaneHttpRoutes(svc)
    const res = await app.request("http://localhost/runtime/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "sandbox_manager_unavailable" },
    })
  })

  test("register and heartbeat surface rejected lease mutations without updating workspace status", async () => {
    const svc = services()
    const register = vi.fn(async () => ({ ok: false as const, reason: "runtime_lease_epoch_mismatch" }))
    const heartbeat = vi.fn(async () => ({ ok: false as const, reason: "runtime_lease_missing" }))
    svc.sandbox.sandboxManager = { register, heartbeat } as never
    const input = {
      workspaceId: "ws_1",
      ok: true,
      status: "ready",
      directory: "/tmp/demo",
      profile: "workspace",
      agentType: "opencode",
      model: "gpt-5.4",
      ptyCount: 0,
      processCount: 0,
      activeProcessCount: 0,
      sandboxId: "sandbox_1",
      epoch: 2,
    }

    await expect(registerControlRuntime(svc, input).catch(errorShape)).resolves.toEqual({
      code: "runtime_lease_epoch_mismatch",
      status: 409,
    })
    await expect(heartbeatControlRuntime(svc, input).catch(errorShape)).resolves.toEqual({
      code: "runtime_lease_missing",
      status: 409,
    })
    expect(mocks.updateWorkspace).not.toHaveBeenCalled()
  })

  test("register endpoint pulls runtime session metadata into projection", async () => {
    const svc = services()
    const runtimeFetch = vi.fn(async (input: { path: string }) => {
      if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
      if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Pulled" })
      return new Response("not found", { status: 404 })
    })
    const app = ControlPlaneHttpRoutes(svc, { runtimeFetch })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "create-1", reason: "session-created" }),
    })

    expect(res.status).toBe(200)
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/global/health" }))
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/session/session-1" }))
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_1" }), {
      id: "session-1",
      title: "Pulled",
    })
  })

  test("pulls a cloud runtime through its ready sandbox target", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "ready",
    })
    const target = vi.fn(async () => ({
      status: "ready" as const,
      hostId: "host_cloud",
      homeRegion: "eu-west",
    }))
    svc.sandbox.sandboxManager = { target } as never
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm", access: "cloud" },
      })),
      upsertSessionVisibility: vi.fn(async () => ({})),
    } as never
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.eu.test")
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    stubFetch(vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/session/session-1")) return Response.json({ id: "session-1" })
      return new Response("not found", { status: 404 })
    }))

    await expect(pullControlSession(svc, {}, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })).resolves.toMatchObject({ ok: true })

    expect(target).toHaveBeenCalledWith("ws_1")
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host_cloud" }))
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1" }))
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", principalKind: "user" }))
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
  })

  test.each([
    {
      name: "organization",
      local: { org_id: "org_stale", project_id: "prj_1" },
      authority: { org_id: "org_team", project_id: "prj_1" },
      code: "workspace_tenant_conflict",
    },
    {
      name: "project",
      local: { org_id: "org_team", project_id: "prj_stale" },
      authority: { org_id: "org_team", project_id: "prj_1" },
      code: "workspace_project_conflict",
    },
  ])("rejects a stale local workspace $name before runtime access", async ({ local, authority, code }) => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      ...local,
      kind: "cloud",
      directory: "/tmp/demo",
      status: "ready",
    })
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "editor",
        workspace: { workspace_id: "ws_1", ...authority, backing: "cloud-vm", access: "cloud" },
      })),
    } as never
    const runtimeFetch = vi.fn()

    await expect(pullControlSession(svc, { runtimeFetch }, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })).rejects.toMatchObject({ status: 409, code })
    expect(runtimeFetch).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("pulls a user-hosted runtime through its active authority host link", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "ready",
    })
    const activeWorkspaceHost = vi.fn(async () => ({
      active: true as const,
      host_id: "host_user",
      workspace_id: "ws_1",
      expires_at: Date.now() + 60_000,
      last_seen_at: Date.now(),
    }))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          workspace_id: "ws_1",
          org_id: "org_1",
          backing: "local-worktree",
          access: "user-hosted",
          home_region: "eu-west",
        },
      })),
      activeWorkspaceHost,
      upsertSessionVisibility: vi.fn(async () => ({})),
    } as never
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.eu.test")
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    stubFetch(vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/session/session-1")) return Response.json({ id: "session-1" })
      return new Response("not found", { status: 404 })
    }))

    await expect(pullControlSession(svc, {}, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })).resolves.toMatchObject({ ok: true })

    expect(activeWorkspaceHost).toHaveBeenCalledWith(signedAuth, { workspaceId: "ws_1" })
    expect(svc.sandbox.sandboxManager).toBeUndefined()
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host_user" }))
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1" }))
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
  })

  test.each([
    {
      name: "inactive user-hosted",
      workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "local-worktree", access: "user-hosted" },
      code: "user_hosted_workspace_unavailable",
      activeWorkspaceHost: vi.fn(async () => ({ active: false as const })),
    },
    {
      name: "unsupported placement",
      workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "local-worktree", access: "cloud" },
      code: "workspace_runtime_unavailable",
      activeWorkspaceHost: vi.fn(),
    },
  ])("fails closed for $name runtime authority", async ({ workspace, code, activeWorkspaceHost }) => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "ready",
    })
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({ role: "owner", workspace })),
      activeWorkspaceHost,
    } as never
    const mintRuntimeAccessToken = vi.fn()
    svc.relay.provider = {
      mintRuntimeAccessToken,
      getRelayEndpoint: vi.fn(),
    } as never
    const fetch = vi.fn()
    stubFetch(fetch)

    await expect(pullControlSession(svc, {}, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })).rejects.toMatchObject({ status: 409, code })

    expect(mintRuntimeAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("rejects a viewer register before contacting the workspace runtime", async () => {
    const svc = services()
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "viewer",
        workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm", access: "cloud" },
      })),
    } as never
    const runtimeFetch = vi.fn()

    await expect(pullControlSession(svc, { runtimeFetch }, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-private",
    })).rejects.toMatchObject({ status: 403, code: "workspace_authorization_denied" })
    expect(runtimeFetch).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("rejects a checkpoint without session write authority before reading or projecting runtime state", async () => {
    const svc = services()
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "editor",
        workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm", access: "cloud" },
      })),
      authorizeSessionWrite: vi.fn(async () => {
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session write access denied")
      }),
    } as never
    const runtimeFetch = vi.fn()

    await expect(pullControlSessionMessages(svc, { runtimeFetch }, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-private",
    })).rejects.toMatchObject({ status: 403, code: "workspace_authorization_denied" })
    expect(runtimeFetch).not.toHaveBeenCalled()
    expect(svc.projectionStore.read_session_max_event_ordinal).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })

  test("idempotency results are isolated by authenticated principal", async () => {
    const svc = services()
    const openWorkspace = vi.fn(async (auth: { user: { subject: string } }) => {
      if (auth.user.subject === "user_2") {
        throw new ControlPlaneAuthError(
          403,
          "workspace_authorization_denied",
          "Workspace access denied",
        )
      }
      return { allowed: true, role: "owner", workspace: { workspace_id: "ws_1" } }
    })
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace,
      upsertSessionVisibility: vi.fn(async () => undefined),
    } as never
    const authConfig = {
      enabled: true,
      issuer: "https://issuer.test",
      jwksUrl: "https://issuer.test/jwks",
    } as const
    const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
      mode: "signed",
      user: {
        subject: token,
        tokenIdentifier: `${config.issuer}|${token}`,
        issuer: config.issuer,
      },
    })
    const app = ControlPlaneHttpRoutes(svc, {
      authConfig,
      verifier,
      runtimeFetch: async (input) => {
        if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (input.path === "/session/session-1") return Response.json({ id: "session-1" })
        return new Response("not found", { status: 404 })
      },
    })
    const request = (token: string) => app.request(
      "http://localhost/workspaces/ws_1/sessions/session-1/register",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "principal-isolation" }),
      },
    )

    expect((await request("user_1")).status).toBe(200)
    expect((await request("user_1")).status).toBe(200)
    const denied = await request("user_2")

    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "workspace_authorization_denied" },
    })
    expect(openWorkspace).toHaveBeenCalledTimes(2)
  })

  test("register rejects runtime session payloads for another session", async () => {
    const svc = services()
    const app = ControlPlaneHttpRoutes(svc, {
      runtimeFetch: async (input: { path: string }) => {
        if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (input.path === "/session/session-1") return Response.json({ id: "session-2", title: "Wrong" })
        return new Response("not found", { status: 404 })
      },
    })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "session-created" }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "workspace_runtime_session_mismatch" },
    })
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("checkpoint rejects older snapshots before replacing messages", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 10)

    const result = await pullControlSessionMessages(
      svc,
      {
        runtimeFetch: async () => Response.json({ workspaceId: "ws_1" }),
      },
      undefined,
      {
        workspaceId: "ws_1",
        sessionId: "session-1",
        expectedEventOrdinal: 9,
      },
    )

    expect(result).toMatchObject({ skipped: true, reason: "older_expected_ordinal" })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })

  test("checkpoint records snapshot ordinals and rejects equal snapshots", async () => {
    const svc = services()
    const messages = [{ info: { id: "msg-1", role: "assistant" }, parts: [] }]

    const result = await pullControlSessionMessages(
      svc,
      {
        runtimeFetch: async (input: { path: string }) => {
          if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
          if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title" })
          if (input.path === "/session/session-1/message?snapshot=1") {
            return Response.json({ messages, maxEventOrdinal: 12, session: { id: "session-1", title: "Settled title" } })
          }
          return new Response("not found", { status: 404 })
        },
      },
      undefined,
      {
        workspaceId: "ws_1",
        sessionId: "session-1",
      },
    )

    expect(result).toMatchObject({ ok: true, messages: 1, maxEventOrdinal: 12 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
      { maxEventOrdinal: 12 },
    )

    const syncSessionMessages = svc.projectionStore.sync_session_messages as ReturnType<typeof vi.fn>
    syncSessionMessages.mockClear()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    svc.projectionStore.read_session_messages = vi.fn(() => messages)
    const stale = await pullControlSessionMessages(
      svc,
      {
        runtimeFetch: async (input: { path: string }) => {
          if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
          if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title" })
          if (input.path === "/session/session-1/message?snapshot=1") {
            return Response.json({ messages, maxEventOrdinal: 12, session: { id: "session-1", title: "Settled title" } })
          }
          return new Response("not found", { status: 404 })
        },
      },
      undefined,
      {
        workspaceId: "ws_1",
        sessionId: "session-1",
      },
    )

    expect(stale).toMatchObject({ skipped: true, reason: "older_snapshot_ordinal" })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })

  test("runtime pull uses canonical sandbox manager and relay target", async () => {
    const svc = services()
    svc.defaultHomeRegion = "eu-west"
    const target = vi.fn(async () => ({
      status: "ready" as const,
      sandboxId: "sandbox_1",
      url: "https://runtime-direct.example.test",
      hostId: "host_manager",
      epoch: 1,
      homeRegion: "eu-west" as const,
    }))
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.example.test")
    svc.sandbox.sandboxManager = { target } as never
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://relay.example.test/workspaces/ws_1/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.example.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [], session: { id: "session-1", title: "Settled title" } })
      }
      if (url === "https://relay.example.test/workspaces/ws_1/session/session-1") {
        return Response.json({ id: "session-1", title: "Settled title" })
      }
      return new Response("not found", { status: 404 })
    })
    stubFetch(fetch)

    await expect(
      pullControlSessionMessages(svc, {}, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 0 })

    expect(target).toHaveBeenCalledWith("ws_1")
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        hostId: "host_manager",
        orgId: "org_1",
        role: "owner",
      }),
    )
    // The canonical snapshot includes session metadata, so only health and
    // snapshot are read for this unsigned checkpoint.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test("runtime pull fails closed without a sandbox manager", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }))
    stubFetch(fetch)

    await expect(
      pullControlSessionMessages(svc, {}, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }).catch(errorShape),
    ).resolves.toEqual({
      status: 503,
      code: "sandbox_unavailable",
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  test("runtime pull fails closed without relay transport after resolving the canonical lease", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready" as const,
        sandboxId: "sandbox_1",
        url: "https://runtime-direct.example.test",
        hostId: "host_manager",
        epoch: 1,
        homeRegion: "us-east" as const,
      })),
    } as never
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }))
    stubFetch(fetch)

    await expect(
      pullControlSessionMessages(svc, {}, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "workspace_runtime_unavailable",
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  test("runtime pull fails closed when the canonical lease is not ready", async () => {
    const svc = services()
    const target = vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "runtime_lease_not_ready",
    }))
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    svc.sandbox.sandboxManager = { target } as never
    svc.relay.provider = {
      mintRuntimeAccessToken,
      getRelayEndpoint: vi.fn(async () => "https://relay.example.test"),
    } as never
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }))
    stubFetch(fetch)

    await expect(
      pullControlSessionMessages(svc, {}, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "cloud_runtime_unavailable",
    })

    expect(mintRuntimeAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("pull endpoints fail closed when runtime identity mismatches", async () => {
    const svc = services()
    const runtimeFetch = vi.fn(async (input: { path: string }) => {
      if (input.path === "/global/health") return Response.json({ workspaceId: "ws_other" })
      return new Response("unexpected runtime request", { status: 500 })
    })
    const app = ControlPlaneHttpRoutes(svc, {
      runtimeFetch,
    })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "session-created" }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "workspace_runtime_mismatch" },
    })
    expect(runtimeFetch).toHaveBeenCalledTimes(1)
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/global/health" }))
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("signed session pull fails 503 workspace_authority_unavailable when authority is missing", async () => {
    // Pins the wire contract of the canonical `requireAuthority` guard on the
    // signed pull path: no configured authority → 503 + this exact code.
    const svc = services()
    expect(svc.authority).toBeUndefined()
    const auth = {
      mode: "signed" as const,
      token: "user_1",
      user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
    }

    await expect(
      pullControlSession(svc, {}, auth, { workspaceId: "ws_1", sessionId: "session-1" }).catch(errorShape),
    ).resolves.toEqual({ status: 503, code: "workspace_authority_unavailable" })
  })

  test("signed gateway resolution fails 503 workspace_authority_unavailable for a cloud workspace without authority", async () => {
    // resolveSessionGateway — a cloud-backed session resolved with signed auth
    // but no authority throws the canonical workspace_authority_unavailable code.
    const svc = services()
    expect(svc.authority).toBeUndefined()
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      host: "workspace" as const,
      workspaceID: "ws_1",
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))
    mocks.resolveWorkspace.mockResolvedValue({ id: "ws_1", kind: "cloud", directory: "/tmp/demo" })
    const auth = {
      mode: "signed" as const,
      token: "user_1",
      user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
    }

    await expect(resolveSessionGateway(svc, "session-1", auth).catch(errorShape)).resolves.toEqual({
      status: 503,
      code: "workspace_authority_unavailable",
    })
  })

  test("invalid workspace ids fail at the protocol boundary", async () => {
    mocks.resolveWorkspace.mockResolvedValue(undefined)

    await expect(
      registerControlRuntime(services(), {
        workspaceId: "missing",
        ok: true,
        status: "ready",
        directory: "/tmp/demo",
        profile: "workspace",
        agentType: "opencode",
        model: null,
        ptyCount: 0,
        processCount: 0,
        activeProcessCount: 0,
      }),
    ).rejects.toThrow("workspace missing not found")
  })
})
