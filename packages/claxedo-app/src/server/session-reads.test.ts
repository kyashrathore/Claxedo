/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionEndpoint } from "./session-context"
import { startSessionReads } from "./session-reads"
import { readTurnPageBefore } from "./transcript-reads"
import { fakeServer, firstPath, firstRead, openPath, openView, ref, shape } from "./test-session-server"

test("session reads: an offline machine's session renders its published row, reads nothing from the machine, and refuses an older page", async () => {
  const server = fakeServer({ reachable: () => false, machine: true })
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.row).toMatchObject({ ref, title: "Ship it", lastHumanTurnAt: 15 })
  expect(first.transcript.entries).toEqual([])
  expect(first.outline).toBeUndefined()
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(await reads.requests).toEqual([])
  expect(server.requests.filter((path) => path.includes("/messages") || path.includes("/outline"))).toEqual([])
  expect(server.runtimeCalls).toEqual([])
  expect(server.hostReads, "an enrolled machine's sessions never ask for a session host").toEqual([])
  await expect(readTurnPageBefore(server.context, ref, shape, "cursor_older")).rejects.toMatchObject({ class: "network" })
  expect(server.runtimeCalls).toEqual([])
})

test("session reads: a machine session's first read lands while its open view is still pending", async () => {
  const facts = Promise.withResolvers<Response>()
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) return facts.promise
      return Response.json([])
    },
  })
  const reads = startSessionReads(server.context, ref, shape)
  try {
    expect((await reads.first).transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  } finally {
    facts.resolve(openView())
    await Promise.all([reads.status, reads.backgroundWork, reads.requests, reads.todos, reads.goal, reads.subagents])
  }
})

test("session reads: a machine session's first read is sent before its open view, so a runtime that answers in arrival order answers it first", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => (path === firstPath ? firstRead() : path === openPath ? openView() : Response.json([])),
  })
  const reads = startSessionReads(server.context, ref, shape)
  await Promise.all([reads.first, reads.status, reads.requests])
  expect(server.runtimeCalls).toEqual([firstPath, openPath])
})

test("session reads: a failed first read rejects the first read and the status it settles, and a failed open view rejects only its facts", async () => {
  const failure = new Error("unavailable")
  const failing = (failed: "first" | "open") =>
    fakeServer({
      reachable: () => true,
      machine: true,
      runtime: (path) => {
        if (path === firstPath) return failed === "first" ? Promise.reject(failure) : firstRead()
        if (path === openPath) return failed === "open" ? Promise.reject(failure) : openView()
        return Response.json([])
      },
    })
  const firstFailed = startSessionReads(failing("first").context, ref, shape)
  expect(await Promise.allSettled([firstFailed.first, firstFailed.status, firstFailed.todos])).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
    { status: "fulfilled", value: [] },
  ])
  const openFailed = startSessionReads(failing("open").context, ref, shape)
  const [first, ...facts] = await Promise.allSettled([openFailed.first, openFailed.status, openFailed.backgroundWork, openFailed.requests, openFailed.todos, openFailed.goal, openFailed.subagents])
  expect(first?.status).toBe("fulfilled")
  for (const fact of facts) expect(fact).toEqual({ status: "rejected", reason: failure })
})

test("session reads: a failed placement lookup rejects every read without an unhandled rejection", async () => {
  const failure = new Error("catalog unavailable")
  const server = fakeServer({ reachable: () => { throw failure } })
  const reads = startSessionReads(server.context, ref, shape)
  const results = await Promise.allSettled([reads.first, reads.status, reads.backgroundWork, reads.requests, reads.todos, reads.goal, reads.subagents])
  for (const result of results) expect(result).toEqual({ status: "rejected", reason: failure })
})

test("session reads: a held latest turn and outline answer the page and outline, so the first read is the row alone", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === sessionEndpoint(ref)) return Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const latestTurn = { entries: [], olderCursor: "before-latest" }
  const outline = { turns: [], complete: true }
  const first = await startSessionReads(server.context, ref, shape, { latestTurn, outline }).first
  expect(first.transcript).toBe(latestTurn)
  expect(first.latestTurn).toBe(latestTurn)
  expect(first.outline).toBe(outline)
  expect(first.row.title).toBe("Live title")
  expect(server.runtimeCalls.filter((path) => path.includes("/message") || path.includes("/outline"))).toEqual([])
})

test("session reads: a harness without todos reads as no todos, and any other todos refusal stays an error", async () => {
  const opened = (todos: unknown) => fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) return openView({ todos })
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const unsupported = { error: { status: 409, code: "unsupported_operation", message: "opencode does not support getTodos" } }
  expect(await startSessionReads(opened(unsupported).context, ref, shape).todos).toEqual([])

  const refused = { error: { status: 403, code: "session_access_denied", message: "Not yours" } }
  await expect(startSessionReads(opened(refused).context, ref, shape).todos).rejects.toMatchObject({ class: "forbidden", code: "session_access_denied" })
})

test("session reads: a cold open of a cloud session no list page has named asks its host once, and a session host serves all of it", async () => {
  const server = fakeServer({
    reachable: () => true,
    sessionHosts: { ses_1: "ses_1" },
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  await server.context.workspaces.load()
  expect(server.context.workspaces.streamRoute(ref), "no live stream while the host is unknown").toBeUndefined()
  const first = await startSessionReads(server.context, ref, shape).first
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(server.hostReads).toEqual(["ses_1"])
  expect(server.context.workspaces.streamRoute(ref)).toMatchObject({ sessionHost: { sessionId: "ses_1" } })
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([])
  expect(server.hostedCalls).toEqual(server.runtimeCalls)
  await startSessionReads(server.context, ref, shape).first
  expect(server.hostReads, "a learned host is never asked again").toEqual(["ses_1"])
})

test("session reads: a cold open of a cloud session its workspace serves asks once, then reads from that runtime", async () => {
  const server = fakeServer({
    reachable: () => true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === sessionEndpoint(ref)) return Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = startSessionReads(server.context, ref, shape)
  await reads.first
  expect((await reads.runtime)?.row).toMatchObject({ title: "Live title" })
  expect(server.hostReads).toEqual(["ses_1"])
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([])
  expect([...server.runtimeCalls].sort()).toEqual([firstPath, sessionEndpoint(ref), openPath].sort())
  expect(server.hostedCalls).toEqual([])
  await startSessionReads(server.context, ref, shape).first
  expect(server.hostReads, "the workspace's answer is remembered too").toEqual(["ses_1"])
})
