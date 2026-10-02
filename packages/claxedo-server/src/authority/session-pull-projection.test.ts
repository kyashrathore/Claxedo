import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "./services"

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  updateWorkspace: vi.fn(async () => undefined),
}))

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
  updateWorkspace: mocks.updateWorkspace,
}))

import { pullHostedControlSession, pullHostedControlSessionMessages } from "./hosted-session-pull"
import { fetchUrl } from "../test-support/fetch-calls"

const originalFetch = globalThis.fetch

function stubFetch(fetch: unknown) {
  globalThis.fetch = fetch as typeof globalThis.fetch
}

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
    },
    auth: localOnlyAuthAdapter("test"),
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
  }
}

const signedAuth = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

// A fully-present workspace authority so the hosted (signed-only) pull flow never
// touches its unavailable path; the tests assert on projection effects, not codes.
function presentAuthority() {
  return {
    // Runtime requests are stamped with the resolved actor from the authority.
    usersMe: vi.fn(async () => ({
      subject: signedAuth.user.subject,
      user_id: "user_1",
      actor_id: "user_1",
      actor_kind: "human",
      actor_public_id: "user_1_pub",
      actor_name: "User One",
    })),
    openWorkspace: vi.fn(async () => ({
      role: "owner",
      workspace: { org_id: "org_1", project_id: "project_1", backing: "cloud-vm" },
    })),
    authorizeSessionWrite: vi.fn(async () => {}),
    upsertSessionVisibility: vi.fn(async () => ({})),
    syncSessionMessages: vi.fn(async (_auth: unknown, _input: { messages: unknown[] }) => ({})),
  }
}

// Wires the hosted pull transport (sandbox lease target + relay provider + fetch)
// so a hosted pull reaches the runtime.
function stubHostedTransport(svc: ControlPlaneServices, runtime: (path: string) => Response | Promise<Response>) {
  svc.sandbox.sandboxManager = {
    target: vi.fn(async () => ({
      status: "ready" as const,
      sandboxId: "sandbox_1",
      url: "https://runtime.example.test",
      hostId: "host_1",
      epoch: 1,
      homeRegion: "us-east" as const,
    })),
  } as never
  svc.relay.provider = {
    mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token" })),
    getRelayEndpoint: vi.fn(async () => "https://relay.example.test"),
  } as never
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = fetchUrl(input)
    const suffix = url.replace("https://relay.example.test/workspaces/ws_1", "")
    return runtime(suffix)
  })
  stubFetch(fetch)
  return fetch
}

describe("hosted pull: session metadata", () => {
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
      status: "ready",
    })
  })

  test.each((["hosted"] as const).flatMap((flow) => [
    [flow, "no time.updated", { created: 100 }],
    [flow, "no time.created", { updated: 200 }],
  ] as const))(
    "%s metadata pull refuses a session with %s before it projects anything",
    async (flow, _label, time) => {
      const svc = services()
      const authority = presentAuthority()
      svc.authority = authority as never
      const runtime = async (path: string) => {
        if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1") return Response.json({ id: "session-1", title: "Untimed", time })
        return new Response("not found", { status: 404 })
      }
      stubHostedTransport(svc, runtime)

      const pull = pullHostedControlSession(svc, undefined, signedAuth, { workspaceId: "ws_1", sessionId: "session-1" })

      await expect(pull).rejects.toMatchObject({ status: 502, code: "workspace_runtime_snapshot_invalid" })
      expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
      expect(authority.upsertSessionVisibility).not.toHaveBeenCalled()
    },
  )

  test.each((["hosted"] as const).flatMap((flow) => [
    [flow, "organization", { project_id: "project_1", backing: "cloud-vm" }],
    [flow, "project", { org_id: "org_1", backing: "cloud-vm" }],
  ] as const))(
    "%s pull refuses a cloud workspace the authority returns without its %s",
    async (flow, _label, workspace) => {
      mocks.resolveWorkspace.mockResolvedValue(undefined)
      const svc = services()
      const authority = { ...presentAuthority(), openWorkspace: vi.fn(async () => ({ role: "owner", workspace })) }
      svc.authority = authority as never
      const runtime = vi.fn(async (path: string) => {
        if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1") return Response.json({ id: "session-1", time: { created: 100, updated: 200 } })
        return new Response("not found", { status: 404 })
      })
      const fetch = stubHostedTransport(svc, runtime)

      const pull = pullHostedControlSession(svc, undefined, signedAuth, { workspaceId: "ws_1", sessionId: "session-1" })

      await expect(pull).rejects.toMatchObject({ status: 409, code: "workspace_identity_required" })
      expect(runtime).not.toHaveBeenCalled()
      if (fetch) expect(fetch).not.toHaveBeenCalled()
      expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    },
  )
})

describe("hosted pull: snapshot validation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mocks.resolveWorkspace.mockClear()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "ready",
    })
  })

  const messages = [{ info: { id: "msg-1", role: "assistant" }, parts: [] }]

  function snapshotWithSession(snapshot: unknown) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray((snapshot as { messages?: unknown }).messages)) {
      return snapshot
    }
    return { ...snapshot, session: { id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } } }
  }

  function httpRuntime(snapshot: unknown) {
    return async (input: { path: string }) => {
      if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
      if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
      if (input.path === "/session/session-1/message?snapshot=1") return Response.json(snapshotWithSession(snapshot) as never)
      return new Response("not found", { status: 404 })
    }
  }

  function hostedRuntime(svc: ControlPlaneServices, snapshot: unknown) {
    return stubHostedTransport(svc, (path) => {
      if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
      if (path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
      if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshotWithSession(snapshot) as never)
      return new Response("not found", { status: 404 })
    })
  }

  test.each([
    null,
    { maxEventOrdinal: 6 },
    { messages: "invalid", maxEventOrdinal: 6 },
  ])("rejects malformed hosted message snapshots before projection", async (snapshot) => {
    const svc = services()
    const authority = presentAuthority()
    svc.authority = authority as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 5)
    hostedRuntime(svc, snapshot)

    await expect(pullHostedControlSessionMessages(
      svc,
      undefined,
      signedAuth,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )).rejects.toMatchObject({
      status: 502,
      code: "workspace_runtime_snapshot_invalid",
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(authority.upsertSessionVisibility).not.toHaveBeenCalled()
  })

  test.each(["hosted"] as const)("%s rejects a checkpoint for a different embedded session", async (flow) => {
    const svc = services()
    svc.authority = presentAuthority() as never
    const snapshot = {
      messages,
      maxEventOrdinal: 12,
      session: { id: "session-other", title: "Wrong session", time: { created: 100, updated: 200 } },
    }
    stubHostedTransport(svc, (path) => {
        if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
        return new Response("not found", { status: 404 })
      })

    const pull = pullHostedControlSessionMessages(
          svc,
          undefined,
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )

    await expect(pull).rejects.toMatchObject({
      status: 409,
      code: "workspace_runtime_session_mismatch",
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test.each(["hosted"] as const)("%s rejects a checkpoint without embedded session metadata", async (flow) => {
    const svc = services()
    svc.authority = presentAuthority() as never
    const snapshot = { messages, maxEventOrdinal: 12 }
    const runtime = async (path: string) => {
      if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
      if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
      return new Response("not found", { status: 404 })
    }
    stubHostedTransport(svc, runtime)

    const pull = pullHostedControlSessionMessages(
          svc,
          undefined,
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )

    await expect(pull).rejects.toMatchObject({
      status: 502,
      code: "workspace_runtime_snapshot_invalid",
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  const untimedSessions = [
    ["no time", {}],
    ["a snake_case updated_at", { updated_at: 200 }],
    ["only a creation time", { time: { created: 100 } }],
    ["only an update time", { time: { updated: 200 } }],
    ["only a snake_case created_at", { created_at: 100 }],
  ] as const
  test.each((["hosted"] as const).flatMap((flow) => untimedSessions.map(([label, stamp]) => [flow, label, stamp] as const)))(
    "%s rejects a checkpoint whose session carries %s instead of its time.created and time.updated",
    async (flow, _label, stamp) => {
      const svc = services()
      const authority = presentAuthority()
      svc.authority = authority as never
      const snapshot = { messages, maxEventOrdinal: 12, session: { id: "session-1", title: "Settled title", ...stamp } }
      const runtime = async (path: string) => {
        if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
        return new Response("not found", { status: 404 })
      }
      stubHostedTransport(svc, runtime)

      const pull = pullHostedControlSessionMessages(
            svc,
            undefined,
            signedAuth,
            { workspaceId: "ws_1", sessionId: "session-1" },
          )

      await expect(pull).rejects.toMatchObject({
        status: 502,
        code: "workspace_runtime_snapshot_invalid",
      })
      expect(authority.syncSessionMessages).not.toHaveBeenCalled()
      expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    },
  )

  test.each(["hosted"] as const)(
    "%s authority sync never synthesizes a newer producer from projection state",
    async (flow) => {
      const svc = services()
      const authority = presentAuthority()
      const older = [{ info: { id: "msg-old", role: "assistant" }, parts: [] }]
      const newer = [{ info: { id: "msg-new", role: "assistant" }, parts: [] }]
      let stored = [] as typeof messages
      let ordinal = 0
      let authorityMessages = [] as typeof messages
      let authorityOrdinal = 0
      let releaseOlderAuthority!: () => void
      const olderAuthority = new Promise<void>((resolve) => {
        releaseOlderAuthority = resolve
      })
      let markOlderAuthorityStarted!: () => void
      const olderAuthorityStarted = new Promise<void>((resolve) => {
        markOlderAuthorityStarted = resolve
      })
      authority.syncSessionMessages = vi.fn(async (_auth, input: {
        messages: unknown[]
        maxEventOrdinal?: number
      }) => {
        if (input.maxEventOrdinal === 11) {
          markOlderAuthorityStarted()
          await olderAuthority
        }
        const incoming = input.maxEventOrdinal ?? 0
        if (incoming < authorityOrdinal) return { applied: false, maxEventOrdinal: authorityOrdinal }
        authorityMessages = input.messages as typeof messages
        authorityOrdinal = incoming
        return { applied: true, maxEventOrdinal: authorityOrdinal }
      })
      svc.authority = authority as never
      svc.projectionStore.read_session_messages = vi.fn(() => stored)
      svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => ordinal)
      svc.projectionStore.sync_session_messages = vi.fn(async (_ws, _sessionId, value, options) => {
        stored = value as typeof messages
        ordinal = options?.maxEventOrdinal ?? 0
        return true
      })
      const runtime = async (path: string) => {
        if (path === "/global/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title", time: { created: 100, updated: 200 } })
        if (path === "/session/session-1/message?snapshot=1") {
          return Response.json(snapshotWithSession({ messages: older, maxEventOrdinal: 11 }) as never)
        }
        return new Response("not found", { status: 404 })
      }
      stubHostedTransport(svc, runtime)
      const pull = pullHostedControlSessionMessages(svc, undefined, signedAuth, {
            workspaceId: "ws_1",
            sessionId: "session-1",
          })

      await olderAuthorityStarted
      stored = newer
      ordinal = 12
      releaseOlderAuthority()
      await expect(pull).resolves.toMatchObject({ ok: true, maxEventOrdinal: 11 })

      expect(authorityMessages).toEqual(older)
      expect(authorityOrdinal).toBe(11)
      expect(authority.syncSessionMessages).toHaveBeenCalledTimes(1)
      expect(authority.syncSessionMessages).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ messages: older, maxEventOrdinal: 11 }),
      )
    },
  )
})
