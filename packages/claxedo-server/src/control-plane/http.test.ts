import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, localOnlyAuthAdapter, type ClerkVerifier } from "./auth"
import type { ControlPlaneServices } from "./services"

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  updateWorkspace: vi.fn(async () => undefined),
}))
const originalFetch = globalThis.fetch

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

vi.mock("../workspace/store/store", () => ({
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
} from "./http"
import { assertRuntimeMutationAuth, runtimeSnapshotInput } from "./http-protocol"

function services(): ControlPlaneServices {
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    extensionPolicy: {},
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
      openWorkspace: vi.fn(async () => ({})),
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
    const payloads = [{ messages }, { messages: messages.slice(0, 1), maxEventOrdinal: 7 }]

    const pull = () =>
      pullControlSessionMessages(
        svc,
        {
          runtimeFetch: async (input: { path: string }) => {
            if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
            if (input.path === "/session/session-1/message?snapshot=1") return Response.json(payloads.shift() ?? { messages })
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
      intakeReady: false,
    })

    vi.mocked(svc.projectionStore.read_session_messages).mockReturnValue(messages)
    vi.mocked(svc.projectionStore.read_session_max_event_ordinal).mockReturnValue(7)

    await expect(pull()).resolves.toMatchObject({ skipped: true, snapshotOrdinal: 7 })

    expect(syncSessionMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: "signed" }), {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages,
      intakeReady: true,
    })
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
      if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
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
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/wr/health" }))
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/session/session-1" }))
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_1" }), {
      id: "session-1",
      title: "Pulled",
    })
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
      openWorkspace,
      upsertSessionVisibility: vi.fn(async () => undefined),
    } as never
    const authConfig = {
      enabled: true,
      issuer: "https://clerk.test",
      jwksUrl: "https://clerk.test/jwks",
    } as const
    const verifier: ClerkVerifier = async (token, config) => ({
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
        if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
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
        if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
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
          if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
          if (input.path === "/session/session-1/message?snapshot=1") {
            return Response.json({ messages, maxEventOrdinal: 12 })
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
          if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
          if (input.path === "/session/session-1/message?snapshot=1") {
            return Response.json({ messages, maxEventOrdinal: 12 })
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
      if (url === "https://relay.example.test/workspaces/ws_1/api/wr/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.example.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [] })
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
    const app = ControlPlaneHttpRoutes(svc, {
      runtimeFetch: async () => Response.json({ workspaceId: "ws_other" }),
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
