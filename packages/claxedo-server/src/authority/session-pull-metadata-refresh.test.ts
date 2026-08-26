/**
 * Regression: the opportunistic session-metadata refresh must never cost us a
 * transcript we already hold.
 *
 * Both message-pull flows fetch the message snapshot, then refresh session
 * metadata, and only afterwards write the transcript via `sync_session_messages`:
 *   - http/session-pull.ts       snapshot -> metadata GET -> sync metadata -> sync_session_messages
 *   - hosted-session-pull.ts     snapshot -> metadata GET -> sync metadata -> sync_session_messages
 *
 * `GET /session/:id` and `GET /session/:id/message` genuinely diverge: the
 * former 404s when the runtime adapter has no record, while the latter has no
 * such guard and still returns the snapshot. Letting the metadata read throw at
 * a checkpoint therefore discarded a perfectly good transcript — and on the
 * hosted path it also skipped `syncAuthority`, leaving Convex on the stale copy
 * the checkpoint was called to replace.
 *
 * The contract pinned here: at a MESSAGE CHECKPOINT the metadata refresh is a
 * bonus and its failure is swallowed (plus telemetry). At REGISTRATION the
 * metadata IS the deliverable, so it stays fatal — the last test in each block
 * proves the fix stayed scoped.
 */
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

import { ControlPlaneHttpRoutes, pullControlSessionMessages } from "./http"
import { pullHostedControlSession, pullHostedControlSessionMessages } from "./hosted-session-pull"

const originalFetch = globalThis.fetch

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

const messages = [
  { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
  { info: { id: "msg-2", role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
]

const CONTROL_REFRESH_FAILED = "authority.session_pull.metadata_refresh_failed"
const HOSTED_REFRESH_FAILED = "authority.hosted_session_pull.metadata_refresh_failed"

function services(): ControlPlaneServices {
  let projectedMessages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async (_ws, _sessionId, msgs) => {
        projectedMessages = msgs as typeof projectedMessages
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
    localExecution: { enabled: true },
  } as unknown as ControlPlaneServices
}

function errorShape(err: unknown) {
  return err && typeof err === "object"
    ? { status: (err as { status?: unknown }).status, code: (err as { code?: unknown }).code }
    : err
}

/** Events the metadata-refresh catch reported, by event name. */
function refreshFailures(svc: ControlPlaneServices, event: string) {
  return vi.mocked(svc.telemetry.capture).mock.calls.filter(([, name]) => name === event)
}

/** Runtime seam for the non-hosted control path: session read is caller-supplied. */
function controlRuntimeFetch(sessionRead: () => Response) {
  return vi.fn(async (input: { path: string }) => {
    if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
    if (input.path === "/session/session-1/message?snapshot=1") return Response.json({ messages })
    if (input.path === "/session/session-1") return sessionRead()
    if (input.path === "/session/status") return Response.json({})
    return new Response("not found", { status: 404 })
  })
}

describe("checkpoint metadata refresh is opportunistic (control path)", () => {
  beforeEach(() => {
    mocks.resolveWorkspace.mockClear()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("a non-2xx GET /session/{id} no longer aborts the checkpoint — the transcript still lands", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => new Response("boom", { status: 500 }))

    await expect(
      pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, sessionId: "session-1", messages: 2 })

    expect(runtimeFetch).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/session/session-1/message?snapshot=1" }),
    )
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    // Only the metadata is lost, and it is reported rather than swallowed silently.
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(svc.telemetry.capture).toHaveBeenCalledWith(
      "system",
      CONTROL_REFRESH_FAILED,
      expect.objectContaining({ sessionId: "session-1", workspaceId: "ws_1" }),
    )
  })

  test("a malformed GET /session/{id} body no longer discards the transcript", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => Response.json({ session: { id: "session-1" } }))

    await expect(
      pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })

    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(refreshFailures(svc, CONTROL_REFRESH_FAILED)).toHaveLength(1)
  })

  test("a healthy session read still refreshes metadata alongside the transcript", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => Response.json({ id: "session-1", title: "Settled title" }))

    await expect(
      pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })

    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    // Positive control: the refresh was made non-fatal, not disabled.
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledTimes(1)
    expect(refreshFailures(svc, CONTROL_REFRESH_FAILED)).toHaveLength(0)
  })

  test("a failed session read costs only the metadata — the next checkpoint backfills it", async () => {
    const svc = services()
    const reads = [
      () => new Response("boom", { status: 503 }),
      () => Response.json({ id: "session-1", title: "Settled title" }),
    ]
    const runtimeFetch = vi.fn(async (input: { path: string }) => {
      if (input.path === "/global/health") return Response.json({ workspaceId: "ws_1" })
      if (input.path === "/session/session-1/message?snapshot=1") return Response.json({ messages })
      if (input.path === "/session/session-1") return (reads.shift() ?? reads[0]!)()
      if (input.path === "/session/status") return Response.json({})
      return new Response("not found", { status: 404 })
    })

    await expect(
      pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()

    await expect(
      pullControlSessionMessages(svc, { runtimeFetch }, undefined, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledTimes(1)
  })

  test("wire contract: POST /checkpoint stays 2xx through a failed session read", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => new Response("boom", { status: 500 }))
    const app = ControlPlaneHttpRoutes(svc, { runtimeFetch })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "message-checkpoint" }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, messages: 2 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
  })

  test("wire contract: POST /checkpoint stays 2xx on a malformed session body", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => Response.json({ session: { id: "session-1" } }))
    const app = ControlPlaneHttpRoutes(svc, { runtimeFetch })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "message-checkpoint" }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, messages: 2 })
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
  })

  test("registration stays fatal: POST /register still surfaces a failed session read", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => new Response("boom", { status: 500 }))
    const app = ControlPlaneHttpRoutes(svc, { runtimeFetch })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "session-created" }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "workspace_runtime_pull_failed" },
    })
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })

  test("/repair reads GET /session/{id} twice per call", async () => {
    const svc = services()
    const runtimeFetch = controlRuntimeFetch(() => Response.json({ id: "session-1", title: "Settled title" }))
    const app = ControlPlaneHttpRoutes(svc, { runtimeFetch })

    const res = await app.request("http://localhost/workspaces/ws_1/sessions/session-1/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "repair" }),
    })

    expect(res.status).toBe(200)
    const sessionReads = runtimeFetch.mock.calls.filter(([input]) => input.path === "/session/session-1")
    expect(sessionReads).toHaveLength(2)
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledTimes(2)
  })
})

describe("checkpoint metadata refresh is opportunistic (hosted path)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function hostedServices() {
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
    const upsertSessionVisibility = vi.fn(async () => ({}))
    svc.authority = {
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "cloud", backing: "cloud-vm", org_id: "org_1" },
      })),
      upsertSessionVisibility,
      syncSessionMessages,
    } as never
    return { svc, syncSessionMessages, upsertSessionVisibility }
  }

  function hostedFetch(sessionRead: () => Response) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/session/session-1/message?snapshot=1")) return Response.json({ messages })
      if (url.endsWith("/session/session-1")) return sessionRead()
      if (url.endsWith("/session/status")) return Response.json({})
      return new Response("not found", { status: 404 })
    })
  }

  test("a non-2xx GET /session/{id} no longer aborts the hosted checkpoint — transcript and authority sync both run", async () => {
    const { svc, syncSessionMessages } = hostedServices()
    const fetch = hostedFetch(() => new Response("boom", { status: 500 }))
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, sessionId: "session-1", messages: 2 })

    expect(fetch).toHaveBeenCalledWith(
      "https://relay.eu.test/workspaces/ws_1/session/session-1/message?snapshot=1",
      expect.anything(),
    )
    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    // The authority sync-back must still run: otherwise Convex keeps the stale transcript.
    expect(syncSessionMessages).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
    expect(svc.telemetry.capture).toHaveBeenCalledWith(
      "system",
      HOSTED_REFRESH_FAILED,
      expect.objectContaining({ sessionId: "session-1", workspaceId: "ws_1" }),
    )
  })

  test("a malformed GET /session/{id} body no longer blocks the hosted transcript write", async () => {
    const { svc, syncSessionMessages, upsertSessionVisibility } = hostedServices()
    globalThis.fetch = hostedFetch(() => Response.json({ session: { id: "session-1" } })) as never

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })

    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    expect(syncSessionMessages).toHaveBeenCalledTimes(1)
    // Visibility is part of the metadata refresh, so it is the one thing skipped.
    expect(upsertSessionVisibility).not.toHaveBeenCalled()
    expect(refreshFailures(svc, HOSTED_REFRESH_FAILED)).toHaveLength(1)
  })

  test("a healthy hosted session read still refreshes metadata and visibility", async () => {
    const { svc, syncSessionMessages, upsertSessionVisibility } = hostedServices()
    globalThis.fetch = hostedFetch(() => Response.json({ id: "session-1", title: "Settled title" })) as never

    await expect(
      pullHostedControlSessionMessages(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: true, messages: 2 })

    expect(svc.projectionStore.sync_session_messages).toHaveBeenCalledTimes(1)
    expect(syncSessionMessages).toHaveBeenCalledTimes(1)
    // Positive control for the hosted refresh.
    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledTimes(1)
    expect(upsertSessionVisibility).toHaveBeenCalledTimes(1)
    expect(refreshFailures(svc, HOSTED_REFRESH_FAILED)).toHaveLength(0)
  })

  test("hosted registration stays fatal: pullHostedControlSession still rejects on a failed session read", async () => {
    const { svc } = hostedServices()
    globalThis.fetch = hostedFetch(() => new Response("boom", { status: 500 })) as never

    await expect(
      pullHostedControlSession(svc, {}, signed, {
        workspaceId: "ws_1",
        sessionId: "session-1",
      }).catch(errorShape),
    ).resolves.toEqual({ status: 500, code: "workspace_runtime_pull_failed" })

    expect(svc.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  })
})
