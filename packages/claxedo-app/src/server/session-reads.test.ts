/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { sessionEndpoint } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { startSessionReads } from "./session-reads"
import { readTurnPageBefore } from "./transcript-reads"
import { centralRow, fakeServer, firstPath, firstRead, openPath, openView, ref, shape, stored } from "./test-session-server"

const centralFirstPath = "/api/control/sessions/ses_1/outline?workspaceId=ws_cloud&rows=40&cols=100&reasoning=0&shell=0&edit=0"

test("session reads: a stopped cloud workspace's session opens from one control-plane first read and reads nothing from its runtime", async () => {
  const server = fakeServer({ reachable: () => false })
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.row).toMatchObject({ ref, title: "Ship it", createdAt: 10, updatedAt: 20, lastHumanTurnAt: 15 })
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(first.transcript.olderCursor).toBe("cursor_older")
  expect(first.outline).toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(await reads.requests).toEqual([])
  expect(await reads.todos).toEqual([])
  expect(await reads.goal).toEqual(NO_GOAL)
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([centralFirstPath])
  expect(server.runtimeCalls).toEqual([])

  await readTurnPageBefore(server.context, ref, shape, "cursor_older")
  expect(server.requests).toContain("/api/control/sessions/ses_1/page?workspaceId=ws_cloud&before=cursor_older&rows=40&cols=100&reasoning=0&shell=0&edit=0")
  expect(server.runtimeCalls).toEqual([])
})

test("session reads: a signed desktop reads a stopped cloud session through its account, never through its local server", async () => {
  const server = fakeServer({ reachable: () => false })
  const calls: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  const account = {
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation, ...(input ? { input } : {}) })
      if (operation === "session.turnPage") return { turns: [{ messages: stored }] }
      if (operation === "session.outline") {
        return { session: centralRow, outline: { turns: [{ id: "msg_1", createdAt: 1, user: "why?" }], complete: true }, page: { turns: [{ messages: stored, cursor: "cursor_older" }] } }
      }
      throw new Error(`unexpected operation ${operation}`)
    },
  } as HostedAccount
  const context = { ...server.context, account }
  const reads = startSessionReads(context, ref, shape)

  const first = await reads.first
  expect(first.row).toMatchObject({ ref, title: "Ship it", lastHumanTurnAt: 15 })
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(first.transcript.olderCursor).toBe("cursor_older")
  expect(first.outline).toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  await readTurnPageBefore(context, ref, shape, "cursor_older")
  expect(calls).toEqual([
    { operation: "session.outline", input: { sessionId: "ses_1", workspaceId: "ws_cloud", rows: "40", cols: "100", reasoning: "0", shell: "0", edit: "0" } },
    { operation: "session.turnPage", input: { sessionId: "ses_1", workspaceId: "ws_cloud", before: "cursor_older", rows: "40", cols: "100", reasoning: "0", shell: "0", edit: "0" } },
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
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.transcript.entries).toHaveLength(2)
  expect(first.row).toMatchObject({ title: "Ship it" })
  expect(first.outline).toMatchObject({ turns: [{ id: "msg_1" }] })
  expect(await reads.requests).toEqual([])
  expect(server.requests.filter((path) => path === "/api/claxedo/bootstrap").length).toBeGreaterThanOrEqual(2)
})

test("session reads: a running cloud workspace's session reads its outline and page from the control plane, and its row and runtime facts from the sandbox", async () => {
  const server = fakeServer({
    reachable: () => true,
    runtime: (path) => {
      if (path === sessionEndpoint(ref)) return Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.outline, "the outline comes from the control plane, whose history the transcript pages").toMatchObject({ turns: [{ id: "msg_1", preview: { user: "why?" } }], complete: true })
  expect(first.row).toMatchObject({ title: "Live title", updatedAt: 30 })
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([centralFirstPath])
  expect([...server.runtimeCalls].sort()).toEqual([sessionEndpoint(ref), openPath].sort())
})

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
  await expect(startSessionReads(opened(refused).context, ref, shape).todos).rejects.toMatchObject({ class: "auth", code: "session_access_denied" })
})
