/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { NO_GOAL } from "./session-goal"
import { readOlder, readSession } from "./session-reads"
import { fakeServer, historyPath, openPath, openView, ref, stored } from "./test-session-server"

test("session reads: a stopped cloud workspace's session renders from the control plane and reads nothing from its runtime", async () => {
  const server = fakeServer({ reachable: () => false })
  const reads = readSession(server.context, ref)

  const surface = await reads.surface
  expect(surface.row).toMatchObject({ ref, title: "Ship it", createdAt: 10, updatedAt: 20, lastHumanTurnAt: 15 })
  expect(surface.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(surface.transcript.olderCursor).toBe("cursor_older")
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(await reads.requests).toEqual([])
  expect(await reads.todos).toEqual([])
  expect(await reads.goal).toEqual(NO_GOAL)
  expect(await reads.outline, "the outline comes from the control plane, with the history").toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  expect(server.requests).toContain("/api/control/sessions/ses_1/outline?workspaceId=ws_cloud")
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&view=latest-surface")
  expect(server.runtimeCalls).toEqual([])

  await readOlder(server.context, ref, "cursor_older")
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&limit=50&before=cursor_older")
  expect(server.runtimeCalls).toEqual([])
})

test("session reads: a signed desktop reads a stopped cloud session through its account, never through its local server", async () => {
  const server = fakeServer({ reachable: () => false })
  const calls: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  const account = {
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation, ...(input ? { input } : {}) })
      if (operation === "session.messages") return { messages: stored, nextCursor: "cursor_older", maxEventOrdinal: 0 }
      if (operation === "session.list") return { sessions: [{ session_id: "ses_1", title: "Ship it", created_at: 10, updated_at: 20, last_human_turn_at: 15 }] }
      if (operation === "session.outline") return { allowed: true, role: "editor", turns: [{ id: "msg_1", createdAt: 1, user: "why?" }], complete: true }
      throw new Error(`unexpected operation ${operation}`)
    },
  } as HostedAccount
  const context = { ...server.context, account }
  const reads = readSession(context, ref)

  const surface = await reads.surface
  expect(surface.row).toMatchObject({ ref, title: "Ship it", lastHumanTurnAt: 15 })
  expect(surface.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(surface.transcript.olderCursor).toBe("cursor_older")
  expect(await reads.outline).toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  await readOlder(context, ref, "cursor_older")
  expect(calls).toEqual([
    { operation: "session.messages", input: { sessionId: "ses_1", workspaceId: "ws_cloud", view: "latest-surface" } },
    { operation: "session.outline", input: { sessionId: "ses_1", workspaceId: "ws_cloud" } },
    { operation: "session.list", input: { workspaceId: "ws_cloud" } },
    { operation: "session.messages", input: { sessionId: "ses_1", workspaceId: "ws_cloud", limit: "50", before: "cursor_older" } },
  ])
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([])
})

test("session reads: a runtime that answers it has stopped re-homes the session to the control plane after re-reading the catalog", async () => {
  let running = true
  const server = fakeServer({
    reachable: () => running,
    runtime: () => {
      running = false
      return Response.json({ error: { code: "workspace_stopped" } }, { status: 409 })
    },
  })
  const reads = readSession(server.context, ref)

  const surface = await reads.surface
  expect(surface.transcript.entries).toHaveLength(2)
  expect(await reads.requests).toEqual([])
  expect(await reads.outline).toMatchObject({ turns: [{ id: "msg_1" }] })
  expect(server.requests.filter((path) => path === "/api/claxedo/bootstrap").length).toBeGreaterThanOrEqual(2)
})

test("session reads: a running cloud workspace's session still reads its history from the control plane; its row and runtime facts from the sandbox", async () => {
  const server = fakeServer({
    reachable: () => true,
    runtime: (path) => {
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = readSession(server.context, ref)

  const surface = await reads.surface
  expect(await reads.outline, "the outline comes from the control plane, whose history the transcript pages").toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  expect(server.requests).toContain("/api/control/sessions/ses_1/outline?workspaceId=ws_cloud")
  expect(server.runtimeCalls).not.toContain("/session/ses_1/outline")
  expect(surface.row).toMatchObject({ title: "Live title", updatedAt: 30 })
  expect(surface.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&view=latest-surface")
  expect(server.runtimeCalls.some((path) => path.includes("/message"))).toBe(false)
})

test("session reads: an offline machine's session renders its published row, reads nothing from the machine, and pages nothing older", async () => {
  const server = fakeServer({ reachable: () => false, machine: true })
  const reads = readSession(server.context, ref)

  const surface = await reads.surface
  expect(surface.row).toMatchObject({ ref, title: "Ship it", lastHumanTurnAt: 15 })
  expect(surface.transcript.entries).toEqual([])
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(await reads.requests).toEqual([])
  expect(server.requests.filter((path) => path.includes("/messages"))).toEqual([])
  expect(server.runtimeCalls).toEqual([])
  expect((await readOlder(server.context, ref, "cursor_older")).entries).toEqual([])
  expect(server.runtimeCalls).toEqual([])
})

for (const machine of [false, true]) {
  test(`session reads: ${machine ? "machine" : "cloud"} history starts while session metadata is pending`, async () => {
    const metadata = Promise.withResolvers<Response>()
    const history = machine ? historyPath : "/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&view=latest-surface"
    const historyAsked = Promise.withResolvers<void>()
    const server = fakeServer({
      reachable: () => true,
      machine,
      requested: (path) => {
        if (path === history) historyAsked.resolve()
      },
      runtime: (path) => {
        if (path === history) historyAsked.resolve()
        if (path === openPath) return metadata.promise
        if (path === historyPath) return Response.json(stored)
        if (path === "/session/ses_1/outline") return Response.json({ turns: [], complete: true })
        return Response.json([])
      },
    })
    const reads = readSession(server.context, ref)
    let landed = false
    const surface = reads.surface.then((value) => { landed = true; return value })
    try {
      await historyAsked.promise
      expect(landed).toBe(false)
    } finally {
      metadata.resolve(openView())
      await Promise.all([surface, reads.status, reads.requests, reads.todos, reads.goal])
    }
    expect((await surface).row.title).toBe("Live title")
    expect((await surface).transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  })
}

for (const failedRead of ["metadata", "history"]) {
  test(`session reads: a failed ${failedRead} read rejects the concurrent surface`, async () => {
    const failure = new Error(`${failedRead} unavailable`)
    const server = fakeServer({
      reachable: () => true,
      machine: true,
      runtime: (path) => {
        if (path === openPath) return failedRead === "metadata" ? Promise.reject(failure) : openView()
        if (path === historyPath) return failedRead === "history" ? Promise.reject(failure) : Response.json(stored)
        if (path === "/session/ses_1/outline") return Response.json({ turns: [], complete: true })
        return Response.json([])
      },
    })
    const reads = readSession(server.context, ref)
    const [surface] = await Promise.allSettled([reads.surface, reads.status, reads.requests, reads.todos, reads.goal])
    expect(surface).toEqual({ status: "rejected", reason: failure })
  })
}

test("session reads: a failed placement lookup rejects every read without an unhandled metadata rejection", async () => {
  const failure = new Error("catalog unavailable")
  const server = fakeServer({ reachable: () => { throw failure } })
  const reads = readSession(server.context, ref)
  const results = await Promise.allSettled([reads.surface, reads.status, reads.requests, reads.todos, reads.goal, reads.outline])
  for (const result of results) expect(result).toEqual({ status: "rejected", reason: failure })
})

test("session reads: a held turn and outline answer the surface and outline reads without a runtime read of either", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const outline = { turns: [], complete: true }
  const latestTurn = { entries: [] }
  const reads = readSession(server.context, ref, { latestTurn, outline })
  expect((await reads.surface).transcript).toBe(latestTurn)
  expect(await reads.outline).toBe(outline)
  expect(server.runtimeCalls.filter((path) => path.includes("/message") || path.includes("/outline"))).toEqual([])
})
