import { afterEach, describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "./services"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { pullHostedControlSessionMessages } from "./hosted-session-pull"

const originalFetch = globalThis.fetch

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
    extensionPolicy: {},
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

describe("hosted session pull", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("pulls through the canonical sandbox target without provisioning", async () => {
    const svc = services()
    const target = vi.fn(async () => ({
      status: "ready" as const,
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
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          access: "cloud",
          backing: "cloud-vm",
          org_id: "org_1",
        },
      })),
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://relay.eu.test/workspaces/ws_1/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [] })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/status") {
        return Response.json({})
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
        orgId: "org_1",
        role: "owner",
      }),
    )
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://relay.eu.test/workspaces/ws_1/global/health")
    expect(syncSessionMessages).toHaveBeenCalledWith(signed, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages: [],
      maxEventOrdinal: 0,
      intakeReady: true,
    })
  })

  test("pulls a user-hosted workspace through its active authority host link", async () => {
    const svc = services()
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.eu.test")
    svc.defaultHomeRegion = "us-east"
    svc.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    const activeLocalHostLink = vi.fn(async () => ({
      active: true as const,
      host_id: "host_user_1",
      workspace_id: "ws_1",
      expires_at: Date.now() + 60_000,
      last_seen_at: Date.now(),
    }))
    const syncSessionMessages = vi.fn(async () => ({}))
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          access: "user-hosted",
          backing: "local-worktree",
          org_id: "org_1",
          home_region: "eu-west",
        },
      })),
      activeLocalHostLink,
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://relay.eu.test/workspaces/ws_1/global/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [] })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/status") {
        return Response.json({})
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

    expect(activeLocalHostLink).toHaveBeenCalledWith(signed, { workspaceId: "ws_1" })
    expect(svc.sandbox.sandboxManager).toBeUndefined()
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws_1",
      hostId: "host_user_1",
      orgId: "org_1",
      role: "owner",
    }))
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test("fails closed when a user-hosted workspace has no active host link", async () => {
    const svc = services()
    const mintRuntimeAccessToken = vi.fn()
    svc.relay.provider = {
      mintRuntimeAccessToken,
      getRelayEndpoint: vi.fn(),
    } as never
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          access: "user-hosted",
          backing: "local-worktree",
          org_id: "org_1",
        },
      })),
      activeLocalHostLink: vi.fn(async () => ({ active: false as const })),
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
      code: "user_hosted_workspace_unavailable",
    })

    expect(mintRuntimeAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("uses the projected transcript when an idle checkpoint returns an older snapshot", async () => {
    const svc = services()
    const messages = [
      { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg-2", role: "assistant" }, parts: [{ type: "text", text: "summary" }] },
    ]
    vi.mocked(svc.projectionStore.read_session_messages).mockReturnValue(messages)
    vi.mocked(svc.projectionStore.read_session_max_event_ordinal).mockReturnValue(7)
    svc.sandbox.sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
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
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "cloud", backing: "cloud-vm", org_id: "org_1" },
      })),
      syncSessionMessages,
    } as never
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/session/session-1/message?snapshot=1")) {
        return Response.json({ messages: messages.slice(0, 1), maxEventOrdinal: 7 })
      }
      if (url.endsWith("/session/status")) return Response.json({})
      return new Response("not found", { status: 404 })
    }) as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ skipped: true, snapshotOrdinal: 7 })

    expect(syncSessionMessages).toHaveBeenCalledWith(signed, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages,
      maxEventOrdinal: 7,
      intakeReady: true,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })

  test("rejects a mismatched runtime identity before pulling session data", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
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
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "cloud", backing: "cloud-vm", org_id: "org_1" },
      })),
      syncSessionMessages,
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
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
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://relay.eu.test/workspaces/ws_1/global/health")
    expect(syncSessionMessages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  })
})
