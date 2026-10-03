import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { RuntimeStore, openNativeSqliteDatabase, messageCompleted, permissionAsked, sessionIdle, sessionError, sessionStatus, sessionUpdated } from "@claxedo/session-core"
import type { AgentEventEnvelope, AgentSession } from "@claxedo/agent-runtime-contract"
import { cloudSessionRows } from "./cloud-session-rows"
import { cloudSessionRowsGrant } from "./cloud-session-rows-grant"
import { createWorkspaceRuntimeApp } from "@claxedo/workspace-runtime"
import { loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })

function store(root?: string) {
  const location = root ?? mkdtempSync(path.join(os.tmpdir(), "cloud-session-rows-"))
  if (!root) cleanups.push(() => rmSync(location, { recursive: true, force: true }))
  const db = openNativeSqliteDatabase(createRequire(import.meta.url), path.join(location, "state.db"))
  const value = new RuntimeStore({ db, location, flush: () => {} })
  cleanups.push(() => value.close())
  return { value, location }
}

function bind(value: RuntimeStore, sessionId = "ses_1", parentSessionId?: string) {
  value.bindSession({ sessionId, workspaceId: "ws_1", directory: "/workspace", connectionId: "primary",
    upstreamSessionId: `up_${sessionId}`, agentSessionId: `up_${sessionId}`, title: sessionId,
    owner: { kind: "person", userId: "owner" }, createdAt: 100, updatedAt: 100,
    ...(parentSessionId ? { parentSessionId } : {}) })
}

function fixture(value: RuntimeStore, replies: Array<(body: any) => Promise<Response>> = []) {
  const publications: any[] = []
  const warns = vi.fn()
  const publisher = cloudSessionRows({ workspaceId: "ws_1", url: "https://plane.test/rows", grant: {
    token: async () => "producer-proof", stop: () => {},
  }, fetch: async (_url, init) => {
    const body = await new Response(init?.body).json()
    publications.push(body)
    return replies.shift()?.(body) ?? Response.json({ accepted: body.rows.length + body.removed.length + body.attention.length, refused: [] })
  }, warn: warns })
  publisher.bindSessionInventory({
    sessions: () => value.listWorkspaceSessionIds("ws_1").map((id) => value.getSession(id) as AgentSession),
    session: (id) => value.getSession(id) ?? undefined,
    removed: () => value.listWorkspaceDeletedRootSessionIds("ws_1"),
    attention: (id, after, limit) => value.sessionAttentionHistory(id, after, limit),
  })
  cleanups.push(() => publisher.drain())
  return { publisher, publications, warns }
}

test("startup sends canonical root rows and recovers short-lived attention from the journal", async () => {
  const { value } = store()
  bind(value)
  bind(value, "ses_child", "ses_1")
  value.appendEvent({ sessionId: "ses_1", payload: permissionAsked({ id: "permission_1", sessionID: "ses_1", permission: "bash", patterns: [], always: [], metadata: {} }) })
  value.appendEvent({ sessionId: "ses_1", payload: { id: "replied", type: "permission.replied", properties: { sessionID: "ses_1", requestID: "permission_1", reply: "once" } } })
  value.appendEvent({ sessionId: "ses_1", payload: messageCompleted("ses_1", "assistant_1") })
  value.appendEvent({ sessionId: "ses_1", payload: sessionIdle("ses_1") })
  const f = fixture(value)
  await f.publisher.flush()
  expect(f.publications).toHaveLength(1)
  expect(f.publications[0].rows.map((row: any) => row.sessionId)).toEqual(["ses_1"])
  expect(f.publications[0].rows[0]).toMatchObject({ status: { kind: "idle", awaitingInput: false }, attention: { awaitingInput: false },
    lastTurn: { status: "completed", assistantMessageId: "assistant_1", completedAt: expect.any(Number) } })
  expect(f.publications[0].attention[0].events).toMatchObject([{ kind: "permission", requestId: "permission_1" }, { kind: "outcome", outcome: "completed" }])
  await f.publisher.flush()
  expect(f.publications).toHaveLength(1)
})

test("startup Working remains replayed when live metadata arrives before its first publication", async () => {
  const { value } = store()
  bind(value)
  value.appendEvent({ sessionId: "ses_1", payload: sessionStatus("ses_1", { type: "busy" }) })
  const f = fixture(value)
  value.updateSession("ses_1", { title: "Renamed while working" })
  f.publisher.onPresentationEvent({ directory: "/workspace", payload: sessionUpdated(value.getSession("ses_1")! as AgentSession) })
  await f.publisher.flush()
  expect(f.publications[0].rows[0]).toMatchObject({ replayed: true, attention: { working: true } })
})

test("a live human turn before the initial batch retains live provenance across HTTP failure and reconciliation", async () => {
  const { value } = store()
  bind(value)
  const f = fixture(value, [async () => new Response(null, { status: 503 })])
  value.startTurn({ sessionId: "ses_1", agentSessionId: "up", userMessageId: "prompt", assistantMessageId: "answer", agent: "build", parts: [{ type: "text", text: "Work" }] })
  const event = sessionStatus("ses_1", { type: "busy" })
  value.appendEvent({ sessionId: "ses_1", payload: event })
  f.publisher.onPresentationEvent({ directory: "/workspace", payload: event })
  await f.publisher.flush()
  await f.publisher.drain()
  expect(f.publications).toHaveLength(2)
  for (const body of f.publications) expect(body.rows[0]).toMatchObject({ replayed: false, attention: { working: true } })
})

test("a newly created root first observed live while Working is not a recovery snapshot", async () => {
  const { value } = store()
  const f = fixture(value)
  bind(value)
  const event = sessionStatus("ses_1", { type: "busy" })
  value.appendEvent({ sessionId: "ses_1", payload: event })
  f.publisher.onPresentationEvent({ directory: "/workspace", payload: event })
  await f.publisher.flush()
  expect(f.publications[0].rows[0]).toMatchObject({ replayed: false, attention: { working: true } })
})

test("a Working root discovered by recovery without a live observation stays replayed", async () => {
  const { value } = store()
  const f = fixture(value)
  bind(value)
  value.appendEvent({ sessionId: "ses_1", payload: sessionStatus("ses_1", { type: "busy" }) })
  await f.publisher.drain()
  expect(f.publications[0].rows[0]).toMatchObject({ replayed: true, attention: { working: true } })
})

test("failed publication retains the attention cursor and a restarted publisher replays durable history", async () => {
  const initial = store()
  bind(initial.value)
  initial.value.appendEvent({ sessionId: "ses_1", payload: sessionError("Failed", "ses_1") })
  const f = fixture(initial.value, [async () => new Response(null, { status: 503 })])
  await f.publisher.flush()
  await f.publisher.flush()
  expect(f.publications[1].attention).toEqual(f.publications[0].attention)
  await f.publisher.drain()
  initial.value.close()
  const reopened = store(initial.location)
  const next = fixture(reopened.value)
  await next.publisher.flush()
  expect(next.publications[0].attention).toEqual(f.publications[0].attention)
})

test("an event committed while publication is in flight remains dirty until its newer row and history land", async () => {
  const { value } = store()
  bind(value)
  let release!: (response: Response) => void
  const f = fixture(value, [async () => new Promise<Response>((resolve) => { release = resolve })])
  const first = f.publisher.flush()
  await vi.waitFor(() => expect(f.publications).toHaveLength(1))
  const event: AgentEventEnvelope = { directory: "/workspace", payload: sessionError("Failed later", "ses_1") }
  value.appendEvent({ sessionId: "ses_1", payload: event.payload })
  f.publisher.onPresentationEvent(event)
  release(Response.json({ accepted: 2, refused: [] }))
  await first
  await f.publisher.flush()
  expect(f.publications[1].rows[0].attention.sequence).toBeGreaterThan(f.publications[0].rows[0].attention.sequence)
  expect(f.publications[1].attention[0].events).toMatchObject([{ kind: "outcome", outcome: "failed" }])
})

test("a restart republishes canonical deletion tombstones", async () => {
  const initial = store()
  bind(initial.value)
  bind(initial.value, "ses_child", "ses_1")
  initial.value.bindSession({ sessionId: "ses_child", directory: "/workspace", agentSessionId: "up_ses_child" })
  initial.value.bindSession({ sessionId: "ses_1", directory: "/workspace", agentSessionId: "up_ses_1" })
  expect(initial.value.getSession("ses_child")).toMatchObject({ parentID: "ses_1" })
  initial.value.deleteSession("ses_1")
  initial.value.close()
  const reopened = store(initial.location)
  const f = fixture(reopened.value)
  await f.publisher.flush()
  expect(f.publications[0]).toEqual({ rows: [], attention: [], removed: [{ workspaceId: "ws_1", sessionId: "ses_1" }] })
})

test("child activity cannot prevent drain from publishing the canonical root inventory", async () => {
  const { value } = store()
  const f = fixture(value)
  bind(value)
  for (let index = 0; index < 5; index++) {
    const sessionId = `ses_child_${index}`
    bind(value, sessionId, "ses_1")
    const event = sessionError("Child failure", sessionId)
    value.appendEvent({ sessionId, payload: event })
    f.publisher.onPresentationEvent({ directory: "/workspace", payload: event })
  }
  await f.publisher.drain()
  expect(f.publications).toHaveLength(1)
  expect(f.publications[0].rows.map((row: any) => row.sessionId)).toEqual(["ses_1"])
})

test("attention pagination sends every durable event before advancing to the final journal boundary", async () => {
  const { value } = store()
  bind(value)
  for (let index = 0; index < 300; index++) value.appendEvent({ sessionId: "ses_1", payload: sessionError(`Failure ${index}`, "ses_1") })
  const f = fixture(value)
  await f.publisher.flush()
  expect(f.publications[0].attention[0].events).toHaveLength(256)
  await f.publisher.flush()
  expect(f.publications[1].attention[0].events).toHaveLength(44)
  expect(f.publications.flatMap((body) => body.attention[0].events).map((event: any) => event.sequence)).toEqual(Array.from({ length: 300 }, (_, index) => index + 2))
  await f.publisher.flush()
  expect(f.publications).toHaveLength(2)
})

test("a rejected batch leaves its history pending and drain covers all canonical root rows", async () => {
  const { value } = store()
  for (let index = 0; index < 9; index++) bind(value, `ses_${index}`)
  value.appendEvent({ sessionId: "ses_0", payload: sessionError("Failure", "ses_0") })
  const f = fixture(value, [async (body) => Response.json({ accepted: 0,
    refused: [...body.rows, ...body.attention].map((ref: any) => ({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, reason: "attention_boundary_changed" })),
  })])
  await f.publisher.flush()
  await f.publisher.flush()
  await f.publisher.drain()
  const retry = f.publications.slice(1).flatMap((body) => body.attention).find((batch) => batch.sessionId === "ses_0")
  expect(retry).toEqual(f.publications[0].attention.find((batch: any) => batch.sessionId === "ses_0"))
  expect(new Set(f.publications.slice(1).flatMap((body) => body.rows.map((row: any) => row.sessionId)))).toEqual(new Set(Array.from({ length: 9 }, (_, index) => `ses_${index}`)))
})

test("individually refused sessions cannot starve other registered sessions during drain", async () => {
  const { value } = store()
  for (let index = 0; index < 4; index++) bind(value, `rejected_${index}`)
  for (let index = 0; index < 5; index++) bind(value, `valid_${index}`)
  const reply = async (body: any) => {
    const refs = [...body.rows, ...body.removed, ...body.attention]
    const refused = refs.filter((ref) => ref.sessionId.startsWith("rejected_"))
      .map((ref) => ({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, reason: "session_unregistered" }))
    return Response.json({ accepted: refs.length - refused.length, refused })
  }
  const f = fixture(value, Array.from({ length: 10 }, () => reply))
  await f.publisher.drain()
  expect(f.publications[0].rows.every((row: any) => row.sessionId.startsWith("rejected_"))).toBe(true)
  expect(new Set(f.publications.flatMap((body) => body.rows.map((row: any) => row.sessionId)).filter((id) => id.startsWith("valid_"))))
    .toEqual(new Set(Array.from({ length: 5 }, (_, index) => `valid_${index}`)))
})

test("producer renewal trades only its own proof and stops returning it after expiry", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const fetch = vi.fn(async () => Response.json({ token: "renewed", expiresAt: 200_000 }))
  const grant = cloudSessionRowsGrant({ token: "original", expiresAt: 50_000, renewUrl: "https://plane.test/renew", fetch })
  cleanups.push(() => grant.stop())
  await vi.advanceTimersByTimeAsync(24_500)
  expect(fetch).toHaveBeenCalledWith("https://plane.test/renew", expect.objectContaining({ headers: { authorization: "Bearer original" } }))
  expect(await grant.token()).toBe("renewed")
  grant.stop()
  expect(await grant.token()).toBeUndefined()
})

test("network recovery redeems an expired boot proof only at the dedicated renewal endpoint", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  let reachable = false
  const calls: Array<{ url: string; authorization: string }> = []
  const grant = cloudSessionRowsGrant({ token: "boot-proof", expiresAt: 2_000, renewUrl: "https://plane.test/renew", fetch: async (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : String(url), authorization: new Headers(init?.headers).get("authorization")! })
    return reachable ? Response.json({ token: "fresh-proof", expiresAt: 200_000 }) : new Response(null, { status: 503 })
  } })
  cleanups.push(() => grant.stop())
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await grant.token()).toBeUndefined()
  reachable = true
  expect(await grant.token()).toBe("fresh-proof")
  expect(calls.every((call) => call.url === "https://plane.test/renew" && call.authorization === "Bearer boot-proof")).toBe(true)
})

test("runtime composition publishes a background outcome and drains before closing its canonical store", async () => {
  const { value } = store()
  bind(value)
  const publications: any[] = []
  const publisher = cloudSessionRows({ workspaceId: "ws_1", url: "https://plane.test/rows", grant: {
    token: async () => "producer-proof", stop: () => {},
  }, fetch: async (_url, init) => {
    const body = await new Response(init?.body).json()
    publications.push(body)
    return Response.json({ accepted: body.rows.length + body.removed.length + body.attention.length, refused: [] })
  } })
  const runtime = createWorkspaceRuntimeApp({ target: { workspaceId: "ws_1", directory: "/workspace" },
    placement: { placement: "cloud", machineOwnerUserId: "owner", canUseOwnLogin: false }, exposure: loopbackWorkspaceRuntimeExposure(),
    sessionIdWorkspace: (id) => value.getExecutionBinding(id)?.workspaceId, storeFactory: () => value,
    bindSessionInventory: publisher.bindSessionInventory.bind(publisher), onPresentationEvent: publisher.onPresentationEvent.bind(publisher),
    beforeStoreClose: publisher.drain.bind(publisher),
  })
  cleanups.push(() => runtime.dispose())
  await publisher.flush()
  const response = await runtime.app.request("/session/ses_1")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ id: "ses_1", status: "idle" })
  const event: AgentEventEnvelope = { directory: "/workspace", payload: sessionError("Background failure", "ses_1") }
  value.appendEvent({ sessionId: "ses_1", payload: event.payload })
  runtime.host.sessionCore.eventHub.publishGlobal(event)
  await runtime.dispose()
  expect(publications.at(-1).attention[0].events).toMatchObject([{ kind: "outcome", outcome: "failed" }])
})
