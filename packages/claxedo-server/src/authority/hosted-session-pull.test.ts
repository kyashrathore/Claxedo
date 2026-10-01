import { afterEach, describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "./services"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { pullHostedControlSession, pullHostedControlSessionMessages } from "./hosted-session-pull"
import { UNUSED_PROJECTION_STORE } from "./unavailable-session-stores"
import { fetchUrl } from "../test-support/fetch-calls"

const originalFetch = globalThis.fetch

function services(): ControlPlaneServices {
  return {
    projectionStore: UNUSED_PROJECTION_STORE,
    durableSessionLog: {
      persist_message_event: vi.fn(),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  }
}

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: {
    subject: "user_1",
    tokenIdentifier: "issuer|user_1",
    issuer: "issuer",
  },
}

const canonicalUsersMe = () => vi.fn(async () => ({
  actor_id: "actor_user_1",
  actor_kind: "human" as const,
}))

describe("hosted session pull", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function authorityServices(ordinal = 7) {
    const svc = services()
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({ role: "owner", workspace: { backing: "cloud-vm", org_id: "org", project_id: "project" } })),
      authorizeSessionWrite: vi.fn(async () => {}),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [], maxEventOrdinal: ordinal })),
      upsertSessionVisibility: vi.fn(async () => ({ ok: true })),
      syncSessionMessages: vi.fn(async () => ({ ok: true, applied: true, maxEventOrdinal: ordinal })),
    } as never
    svc.sandbox.sandboxManager = { target: async () => ({ status: "ready", hostId: "host", homeRegion: "us-east" }) } as never
    svc.relay.provider = {
      mintRuntimeAccessToken: async () => ({ token: "runtime" }), getRelayEndpoint: async () => "https://runtime.test",
    } as never
    return svc
  }

  test("register refreshes D1 metadata without touching the unavailable projection", async () => {
    const svc = authorityServices()
    globalThis.fetch = vi.fn(async (input) => fetchUrl(input).endsWith("/global/health")
      ? Response.json({ workspaceId: "ws" })
      : Response.json({ id: "ses", title: "Registered", time: { created: 1, updated: 200 } })) as unknown as typeof fetch
    await expect(pullHostedControlSession(svc, {}, signed, { workspaceId: "ws", sessionId: "ses" })).resolves.toEqual({ ok: true, sessionId: "ses" })
    expect(svc.authority!.upsertSessionVisibility).toHaveBeenCalledWith(signed, {
      workspaceId: "ws", sessions: [{ sessionId: "ses", title: "Registered", updatedAt: 200 }],
    })
  })

  test("an expected ordinal behind D1 skips the runtime entirely", async () => {
    const svc = authorityServices(8)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(pullHostedControlSessionMessages(svc, {}, signed, { workspaceId: "ws", sessionId: "ses", expectedEventOrdinal: 7 }))
      .resolves.toEqual({ ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal: 8 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(svc.authority!.syncSessionMessages).not.toHaveBeenCalled()
  })

  test("a hosted snapshot without the runtime ordinal is refused before any write", async () => {
    const svc = authorityServices()
    globalThis.fetch = vi.fn(async (input) => fetchUrl(input).endsWith("/global/health")
      ? Response.json({ workspaceId: "ws" })
      : Response.json({ session: { id: "ses", time: { created: 1, updated: 200 } }, messages: [] })) as unknown as typeof fetch
    await expect(pullHostedControlSessionMessages(svc, {}, signed, { workspaceId: "ws", sessionId: "ses" }))
      .rejects.toMatchObject({ status: 502, code: "workspace_runtime_snapshot_invalid" })
    expect(svc.authority!.syncSessionMessages).not.toHaveBeenCalled()
    expect(svc.authority!.upsertSessionVisibility).not.toHaveBeenCalled()
  })

  test("pulls through the canonical sandbox target without provisioning", async () => {
    const svc = services()
    const target = vi.fn(async () => ({
      status: "ready" as const,
      routingId: "routing_test",
      workspaceId: "ws_1",
      sandboxId: "sandbox_1",
      url: "https://runtime-direct.example.test",
      hostId: "host_manager",
      epoch: 7,
      homeRegion: "eu-west" as const,
    }))
    const ensure = vi.fn()
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.eu.test")
    svc.defaultHomeRegion = "us-east"
    svc.sandbox.sandboxManager = { target, ensure } as never
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    const syncSessionMessages = vi.fn(async () => ({}))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "editor",
        workspace: {
          backing: "cloud-vm",
          org_id: "org_1",
          project_id: "project_1",
        },
      })),
      authorizeSessionWrite: vi.fn(async () => {}),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [], maxEventOrdinal: 0 })),
      upsertSessionVisibility: vi.fn(async () => ({})),
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url === "https://relay.eu.test/workspaces/ws_1/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [], maxEventOrdinal: 0, session: { id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } } })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1") {
        return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
      }
      return new Response("not found", { status: 404 })
    })
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 0 })

    expect(target).toHaveBeenCalledWith("ws_1")
    expect(ensure).not.toHaveBeenCalled()
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        hostId: "host_manager",
        routingId: "routing_test",
        orgId: "org_1",
        role: "editor",
        principalKind: "user",
      }),
    )
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    // The snapshot carries its canonical session, so checkpointing adds no
    // second health probe, separate session read or status read.
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetchUrl(fetch.mock.calls[0]?.[0])).toBe("https://relay.eu.test/workspaces/ws_1/global/health")
    expect(syncSessionMessages).toHaveBeenCalledWith(signed, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages: [],
      updatedAt: 200,
      maxEventOrdinal: 0,
    })
  })

  test("pulls a machine-placed workspace through its active authority host link", async () => {
    const svc = services()
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.eu.test")
    svc.defaultHomeRegion = "us-east"
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    const activeWorkspaceHost = vi.fn(async () => ({
      active: true as const,
      host_id: "host_user_1",
      workspace_id: "ws_1",
      expires_at: Date.now() + 60_000,
      last_seen_at: Date.now(),
    }))
    const syncSessionMessages = vi.fn(async () => ({}))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          backing: "local-worktree",
          org_id: "org_1",
          project_id: "project_1",
          home_region: "eu-west",
        },
      })),
      authorizeSessionWrite: vi.fn(async () => {}),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [], maxEventOrdinal: 0 })),
      upsertSessionVisibility: vi.fn(async () => ({})),
      activeWorkspaceHost,
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url === "https://relay.eu.test/workspaces/ws_1/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({
          messages: [{ info: { id: "message-1", role: "user" }, parts: [] }],
          maxEventOrdinal: 7,
          fencingToken: 3,
          session: { id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } },
        })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1") {
        return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
      }
      return new Response("not found", { status: 404 })
    })
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 1, maxEventOrdinal: 7 })

    expect(activeWorkspaceHost).toHaveBeenCalledWith(signed, { workspaceId: "ws_1" })
    expect(svc.sandbox.sandboxManager).toBeUndefined()
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws_1",
      hostId: "host_user_1",
      orgId: "org_1",
      role: "owner",
      // The signed caller rides the user mint so the composition can record
      // it under the caller rather than the service-only path that refused it.
      principalKind: "user",
      auth: signed,
    }))
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(syncSessionMessages).toHaveBeenCalledWith(signed, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages: [{ info: { id: "message-1", role: "user" }, parts: [] }],
      updatedAt: 200,
      maxEventOrdinal: 7,
      fencingToken: 3,
    })
  })

  test("fails closed when a machine-placed workspace has no active host link", async () => {
    const svc = services()
    const mintRuntimeAccessToken = vi.fn()
    svc.relay.provider = {
      mintRuntimeAccessToken,
      getRelayEndpoint: vi.fn(),
    } as never
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          backing: "local-worktree",
          org_id: "org_1",
          project_id: "project_1",
        },
      })),
      authorizeSessionWrite: vi.fn(async () => {}),
      activeWorkspaceHost: vi.fn(async () => ({ active: false as const })),
    } as never
    const fetch = vi.fn()
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workspace_host_offline",
    })

    expect(mintRuntimeAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("the authority decides whether an equal-ordinal snapshot applies", async () => {
    const svc = services()
    const messages = [
      { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg-2", role: "assistant" }, parts: [{ type: "text", text: "summary" }] },
    ]
    svc.sandbox.sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        routingId: "routing_test",
        workspaceId: "ws_1",
        sandboxId: "sandbox_1",
        url: "https://runtime-direct.example.test",
        hostId: "host_manager",
        epoch: 7,
        homeRegion: "eu-west",
      })),
    } as never
    svc.relay.provider = {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token" })),
      getRelayEndpoint: vi.fn(async () => "https://relay.eu.test"),
    } as never
    const syncSessionMessages = vi.fn(async () => ({ ok: true, applied: false, maxEventOrdinal: 7 }))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { backing: "cloud-vm", org_id: "org_1", project_id: "project_1" },
      })),
      authorizeSessionWrite: vi.fn(async () => {}),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages, maxEventOrdinal: 7 })),
      upsertSessionVisibility: vi.fn(async () => ({})),
      syncSessionMessages,
    } as never
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/session/session-1/message?snapshot=1")) {
        return Response.json({
          messages,
          maxEventOrdinal: 7,
          fencingToken: 3,
          session: { id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } },
        })
      }
      if (url.endsWith("/session/session-1")) {
        return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
      }
      return new Response("not found", { status: 404 })
    }) as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ skipped: true, snapshotOrdinal: 7 })

    expect(syncSessionMessages).toHaveBeenCalledWith(signed, expect.objectContaining({
      messages,
      maxEventOrdinal: 7,
      fencingToken: 3,
    }))
  })

  test("rejects a mismatched runtime identity before pulling session data", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        routingId: "routing_test",
        workspaceId: "ws_1",
        sandboxId: "sandbox_1",
        url: "https://runtime-direct.example.test",
        hostId: "host_manager",
        epoch: 7,
        homeRegion: "eu-west",
      })),
    } as never
    svc.relay.provider = {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token" })),
      getRelayEndpoint: vi.fn(async () => "https://relay.eu.test"),
    } as never
    const syncSessionMessages = vi.fn(async () => ({}))
    svc.authority = {
      usersMe: canonicalUsersMe(),
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { backing: "cloud-vm", org_id: "org_1", project_id: "project_1" },
      })),
      authorizeSessionWrite: vi.fn(async () => {}),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [], maxEventOrdinal: 0 })),
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_other" })
      return new Response("unexpected runtime request", { status: 500 })
    })
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workspace_runtime_mismatch",
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetchUrl(fetch.mock.calls[0]?.[0])).toBe("https://relay.eu.test/workspaces/ws_1/global/health")
    expect(syncSessionMessages).not.toHaveBeenCalled()
  })
})
