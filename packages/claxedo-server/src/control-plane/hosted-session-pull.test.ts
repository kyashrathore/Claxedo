import { afterEach, describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "./services"
import { localOnlyAuthAdapter } from "./auth"
import { pullHostedControlSessionMessages } from "./hosted-session-pull"

const originalFetch = globalThis.fetch

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
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: {
          access: "cloud",
          backing: "cloud-vm",
          org_id: "org_1",
        },
      })),
      syncSessionMessages: vi.fn(async () => ({})),
    } as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://relay.eu.test/workspaces/ws_1/api/wr/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [] })
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
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws_1",
      hostId: "host_manager",
      orgId: "org_1",
      role: "owner",
    }))
    expect(getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
