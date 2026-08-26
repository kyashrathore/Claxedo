import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "./services"

// Unit 6 characterization pins for the CENTRAL storage boundary: the two
// session-pull flows (`http-session-pull.ts` local-cloud + `hosted-session-pull.ts`
// Worker) write pulled runtime state through the `ProjectionStore` port, and the
// "only update when newer" ordinal/snapshot skip rules are pinned exactly as the
// code implements them today. These pins protect the seam while later work dissolves the
// SyncDB bag into `createSqliteCentralStore()`.
//
// Authority is kept PRESENT (stubbed) or out of play (unsigned/undefined auth) so
// authority error codes never appear in these assertions — another agent is
// renaming those codes concurrently.

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  updateWorkspace: vi.fn(async () => undefined),
}))

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
  updateWorkspace: mocks.updateWorkspace,
}))

import { pullControlSession, pullControlSessionMessages } from "./http/session-pull"
import { pullHostedControlSession, pullHostedControlSessionMessages } from "./hosted-session-pull"

const originalFetch = globalThis.fetch

function stubFetch(fetch: unknown) {
  globalThis.fetch = fetch as typeof globalThis.fetch
}

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
    auth: localOnlyAuthAdapter("test"),
    credentials: {} as never,
    extensionPolicy: {},
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

// A fully-present Convex authority so the hosted (signed-only) pull flow never
// touches its unavailable path; the tests assert on projection effects, not codes.
function presentAuthority() {
  return {
    openWorkspace: vi.fn(async () => ({ workspace: { org_id: "org_1" } })),
    upsertSessionVisibility: vi.fn(async () => ({})),
    syncSessionMessages: vi.fn(async () => ({})),
    resolveOrgId: vi.fn(async () => "org_1"),
  }
}

// Wires the hosted pull transport (sandbox lease target + relay provider + fetch)
// so a hosted pull reaches the runtime and lands in the projection store.
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
    const url = String(input)
    const suffix = url.replace("https://relay.example.test/workspaces/ws_1", "")
    return runtime(suffix)
  })
  stubFetch(fetch)
  return fetch
}

describe("central projection: pulled session metadata", () => {
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

  test("http pull writes pulled session meta through ProjectionStore.sync_session_meta", async () => {
    // http-session-pull.ts:82 — a successful pull always writes the pulled
    // runtime session payload through the projection port for the resolved ws.
    const svc = services()
    const result = await pullControlSession(
      svc,
      {
        runtimeFetch: async (input: { path: string }) => {
          if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
          if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Pulled" })
          return new Response("not found", { status: 404 })
        },
      },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({ ok: true, sessionId: "session-1" })
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      { id: "session-1", title: "Pulled" },
    )
  })

  test("hosted pull writes pulled session meta through ProjectionStore.sync_session_meta", async () => {
    // hosted-session-pull.ts:203 — the Worker pull flow writes the pulled
    // runtime session payload through the projection port (authority present).
    const svc = services()
    svc.authority = presentAuthority() as never
    stubHostedTransport(svc, (path) => {
      if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
      if (path === "/session/session-1") return Response.json({ id: "session-1", title: "Hosted" })
      return new Response("not found", { status: 404 })
    })

    const result = await pullHostedControlSession(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(result).toMatchObject({ ok: true, sessionId: "session-1" })
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      { id: "session-1", title: "Hosted" },
    )
  })

  test.each(["http", "hosted"] as const)(
    "%s checkpoint refreshes the settled runtime title in projection and signed visibility",
    async (flow) => {
      const svc = services()
      const authority = presentAuthority()
      svc.authority = authority as never
      const runtime = async (path: string) => {
        if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1/message?snapshot=1") {
          return Response.json({
            messages: [],
            maxEventOrdinal: 4,
            session: {
              id: "session-1",
              title: "Runtime auto-title",
              time: { created: 100, updated: 200 },
            },
          })
        }
        if (path === "/session/status") return Response.json({})
        return new Response("not found", { status: 404 })
      }
      if (flow === "hosted") stubHostedTransport(svc, runtime)

      const result = flow === "http"
        ? await pullControlSessionMessages(svc, { runtimeFetch: ({ path }) => runtime(path) }, signedAuth, {
            workspaceId: "ws_1",
            sessionId: "session-1",
          })
        : await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
            workspaceId: "ws_1",
            sessionId: "session-1",
          })

      expect(result).toMatchObject({ ok: true, sessionId: "session-1" })
      expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ws_1" }),
        expect.objectContaining({ id: "session-1", title: "Runtime auto-title" }),
      )
      expect(authority.upsertSessionVisibility).toHaveBeenCalledWith(signedAuth, {
        workspaceId: "ws_1",
        sessions: [{ sessionId: "session-1", title: "Runtime auto-title", createdAt: 100, updatedAt: 200 }],
      })
    },
  )
})

// The exact snapshot skip rules, pinned once per flow. Both flows share identical
// logic; each rule is exercised against http and hosted pull.
//
//   currentOrdinal = projectionStore.read_session_max_event_ordinal(sessionId)
//   currentMessages = projectionStore.read_session_messages(sessionId)
//
//   RULE 1 (older expected ordinal, checked BEFORE fetching the snapshot):
//     expectedEventOrdinal !== undefined && expectedEventOrdinal < currentOrdinal
//       -> skipped reason "older_expected_ordinal"
//   RULE 2 (older payload ordinal):
//     payload.maxEventOrdinal !== undefined && payload.maxEventOrdinal < currentOrdinal
//       -> skipped reason "older_snapshot_ordinal"
//   RULE 3 (equal payload ordinal, not strictly longer than what we have):
//     payload.maxEventOrdinal === currentOrdinal && currentMessages.length > 0
//       && payload.messages.length <= currentMessages.length
//       -> skipped reason "older_snapshot_ordinal"
//     (NOTE: an equal-ordinal snapshot that is STRICTLY LONGER than the stored
//      messages is NOT skipped — it writes.)
//   RULE 4 (no ordinal, shorter payload):
//     payload.maxEventOrdinal === undefined && payload.messages.length < currentMessages.length
//       -> skipped reason "shorter_snapshot"
//   WRITE (default): otherwise sync_session_messages is called; when an ordinal
//     is present it is forwarded as { maxEventOrdinal }.
describe("central projection: snapshot ordinal skip rules", () => {
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
    return { ...snapshot, session: { id: "session-1", title: "Settled title" } }
  }

  function httpRuntime(snapshot: unknown) {
    return async (input: { path: string }) => {
      if (input.path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
      if (input.path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title" })
      if (input.path === "/session/session-1/message?snapshot=1") return Response.json(snapshotWithSession(snapshot) as never)
      return new Response("not found", { status: 404 })
    }
  }

  function hostedRuntime(svc: ControlPlaneServices, snapshot: unknown) {
    return stubHostedTransport(svc, (path) => {
      if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
      if (path === "/session/session-1") return Response.json({ id: "session-1", title: "Settled title" })
      if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshotWithSession(snapshot) as never)
      return new Response("not found", { status: 404 })
    })
  }

  test.each([
    ["http", null],
    ["http", { maxEventOrdinal: 6 }],
    ["http", { messages: null, maxEventOrdinal: 6 }],
  ])("rejects malformed %s message snapshots before projection", async (_flow, snapshot) => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 5)

    await expect(pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime(snapshot) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )).rejects.toMatchObject({
      status: 502,
      code: "workspace_runtime_snapshot_invalid",
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

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

  test("RULE 1 http: older expectedEventOrdinal skips before fetching", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 10)
    const runtimeFetch = vi.fn(async () => Response.json({ workspaceId: "ws_1" }))

    const result = await pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      expectedEventOrdinal: 9,
    })

    expect(result).toMatchObject({ ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal: 10 })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    // Skip happens before any runtime fetch (not even the health probe runs).
    expect(runtimeFetch).not.toHaveBeenCalled()
  })

  test("RULE 1 hosted: older expectedEventOrdinal skips before fetching", async () => {
    const svc = services()
    svc.authority = presentAuthority() as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 10)
    const fetch = hostedRuntime(svc, { messages, maxEventOrdinal: 5 })

    const result = await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      expectedEventOrdinal: 9,
    })

    expect(result).toMatchObject({ ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal: 10 })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("RULE 2 http: older payload maxEventOrdinal is skipped as older_snapshot_ordinal", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)

    const result = await pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime({ messages, maxEventOrdinal: 11 }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal: 12,
      snapshotOrdinal: 11,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("RULE 2 hosted: older payload maxEventOrdinal is skipped as older_snapshot_ordinal", async () => {
    const svc = services()
    const authority = presentAuthority()
    svc.authority = authority as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    hostedRuntime(svc, { messages, maxEventOrdinal: 11 })

    const result = await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal: 12,
      snapshotOrdinal: 11,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(authority.upsertSessionVisibility).not.toHaveBeenCalled()
  })

  test.each(["http", "hosted"] as const)("%s rejects a checkpoint for a different embedded session", async (flow) => {
    const svc = services()
    svc.authority = presentAuthority() as never
    const snapshot = {
      messages,
      maxEventOrdinal: 12,
      session: { id: "session-other", title: "Wrong session" },
    }
    if (flow === "hosted") {
      stubHostedTransport(svc, (path) => {
        if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
        return new Response("not found", { status: 404 })
      })
    }

    const pull = flow === "http"
      ? pullControlSessionMessages(
          svc,
          {
            runtimeFetch: async ({ path }) => {
              if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
              if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
              return new Response("not found", { status: 404 })
            },
          },
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )
      : pullHostedControlSessionMessages(
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

  test.each(["http", "hosted"] as const)("%s rejects a checkpoint without embedded session metadata", async (flow) => {
    const svc = services()
    svc.authority = presentAuthority() as never
    const snapshot = { messages, maxEventOrdinal: 12 }
    const runtime = async (path: string) => {
      if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
      if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
      return new Response("not found", { status: 404 })
    }
    if (flow === "hosted") stubHostedTransport(svc, runtime)

    const pull = flow === "http"
      ? pullControlSessionMessages(
          svc,
          { runtimeFetch: ({ path }) => runtime(path) },
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )
      : pullHostedControlSessionMessages(
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

  test.each(["http", "hosted"] as const)("%s persists an accepted transcript before visibility propagation", async (flow) => {
    const svc = services()
    const authority = presentAuthority()
    authority.upsertSessionVisibility.mockRejectedValue(new Error("visibility unavailable"))
    svc.authority = authority as never
    const snapshot = {
      messages,
      maxEventOrdinal: 12,
      session: {
        id: "session-1",
        title: "Settled title",
        time: { created: 100, updated: 200 },
      },
    }
    if (flow === "hosted") {
      stubHostedTransport(svc, (path) => {
        if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
        if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
        if (path === "/session/status") return Response.json({})
        return new Response("not found", { status: 404 })
      })
    }

    const pull = flow === "http"
      ? pullControlSessionMessages(
          svc,
          {
            runtimeFetch: async ({ path }) => {
              if (path === "/api/wr/health") return Response.json({ workspaceId: "ws_1" })
              if (path === "/session/session-1/message?snapshot=1") return Response.json(snapshot)
              if (path === "/session/status") return Response.json({})
              return new Response("not found", { status: 404 })
            },
          },
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )
      : pullHostedControlSessionMessages(
          svc,
          undefined,
          signedAuth,
          { workspaceId: "ws_1", sessionId: "session-1" },
        )

    await expect(pull).rejects.toThrow("visibility unavailable")
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
      { maxEventOrdinal: 12 },
    )
    expect(authority.syncSessionMessages).toHaveBeenCalled()
  })

  test("RULE 3 http: equal ordinal with a not-longer payload is skipped", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    svc.projectionStore.read_session_messages = vi.fn(() => messages)

    const result = await pullControlSessionMessages(
      svc,
      // equal ordinal, payload length (1) <= stored length (1) -> skip
      { runtimeFetch: httpRuntime({ messages, maxEventOrdinal: 12 }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal: 12,
      snapshotOrdinal: 12,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      expect.objectContaining({ id: "session-1", title: "Settled title" }),
    )
  })

  test("RULE 3 boundary http: equal ordinal but STRICTLY LONGER payload WRITES", async () => {
    // Pins the exact equal-ordinal behavior: equal is skipped only when the
    // snapshot is not longer. A strictly longer equal-ordinal snapshot writes.
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    svc.projectionStore.read_session_messages = vi.fn(() => messages) // length 1
    const longer = [...messages, { info: { id: "msg-2", role: "user" }, parts: [] }] // length 2

    const result = await pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime({ messages: longer, maxEventOrdinal: 12 }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({ ok: true, messages: 2, maxEventOrdinal: 12 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      longer,
      { maxEventOrdinal: 12 },
    )
  })

  test("RULE 3 boundary http: equal ordinal with NO stored messages WRITES", async () => {
    // currentMessages.length > 0 is required to skip; with an empty projection
    // an equal-ordinal snapshot still writes.
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    svc.projectionStore.read_session_messages = vi.fn(() => []) // empty

    const result = await pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime({ messages, maxEventOrdinal: 12 }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({ ok: true, messages: 1, maxEventOrdinal: 12 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
      { maxEventOrdinal: 12 },
    )
  })

  test("RULE 3 hosted: equal ordinal with a not-longer payload is skipped", async () => {
    const svc = services()
    svc.authority = presentAuthority() as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 12)
    svc.projectionStore.read_session_messages = vi.fn(() => messages)
    hostedRuntime(svc, { messages, maxEventOrdinal: 12 })

    const result = await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal: 12,
      snapshotOrdinal: 12,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      expect.objectContaining({ id: "session-1", title: "Settled title" }),
    )
  })

  test("RULE 4 http: no ordinal + shorter payload is skipped as shorter_snapshot", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 0)
    svc.projectionStore.read_session_messages = vi.fn(() => messages) // stored length 1

    const result = await pullControlSessionMessages(
      svc,
      // no maxEventOrdinal, payload length 0 < stored length 1 -> shorter_snapshot
      { runtimeFetch: httpRuntime({ messages: [] }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "shorter_snapshot",
      currentMessages: 1,
      snapshotMessages: 0,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("RULE 4 hosted: no ordinal + shorter payload is skipped as shorter_snapshot", async () => {
    const svc = services()
    const authority = presentAuthority()
    svc.authority = authority as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 0)
    svc.projectionStore.read_session_messages = vi.fn(() => messages)
    hostedRuntime(svc, { messages: [] })

    const result = await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "shorter_snapshot",
      currentMessages: 1,
      snapshotMessages: 0,
    })
    expect(svc.projectionStore.sync_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(authority.upsertSessionVisibility).not.toHaveBeenCalled()
  })

  test("WRITE http: newer ordinal snapshot writes with the ordinal forwarded", async () => {
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 10)

    const result = await pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime({ messages, maxEventOrdinal: 12 }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({ ok: true, messages: 1, maxEventOrdinal: 12 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
      { maxEventOrdinal: 12 },
    )
  })

  test("WRITE http: ordinal-less snapshot writes without an options bag", async () => {
    // payload.maxEventOrdinal === undefined path -> sync_session_messages is
    // called with THREE args (no { maxEventOrdinal }).
    const svc = services()
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 0)
    svc.projectionStore.read_session_messages = vi.fn(() => [])

    const result = await pullControlSessionMessages(
      svc,
      { runtimeFetch: httpRuntime({ messages }) },
      undefined,
      { workspaceId: "ws_1", sessionId: "session-1" },
    )

    expect(result).toMatchObject({ ok: true, messages: 1 })
    expect(result).not.toHaveProperty("maxEventOrdinal")
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
    )
  })

  test("WRITE hosted: newer ordinal snapshot writes with the ordinal forwarded", async () => {
    const svc = services()
    svc.authority = presentAuthority() as never
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 10)
    hostedRuntime(svc, { messages, maxEventOrdinal: 12 })

    const result = await pullHostedControlSessionMessages(svc, undefined, signedAuth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(result).toMatchObject({ ok: true, messages: 1, maxEventOrdinal: 12 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      "session-1",
      messages,
      { maxEventOrdinal: 12 },
    )
  })
})
