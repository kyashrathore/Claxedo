/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { sessionEndpoint } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { ServerError } from "./errors"
import { startSessionReads } from "./session-reads"
import { readPart, readTurnPageBefore } from "./transcript-reads"
import { withQuery } from "./transport"
import { viewportQuery } from "./wire/turn-page"
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

test("session reads: a scoped connection finding no runtime re-reads the catalog and renders its stopped history", async () => {
  let running = true
  const server = fakeServer({ reachable: () => running, runtime: () => {
    running = false
    throw new ServerError({ class: "conflict", code: "workspace_host_offline", message: "Nothing is serving this session's workspace right now" })
  } })
  const reads = startSessionReads(server.context, ref, shape)
  const results = await Promise.allSettled([reads.first, reads.status, reads.requests, reads.todos, reads.goal, reads.subagents, reads.backgroundWork])
  expect(results.every((result) => result.status === "fulfilled")).toBe(true)
  expect((await reads.first).transcript.entries).toHaveLength(2)
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(server.requests.filter((path) => path === "/api/claxedo/bootstrap").length).toBeGreaterThanOrEqual(2)
})

test("session reads: an offline connection refusal preserves cloud history but refuses live facts if the refreshed catalog still says live", async () => {
  const failure = new ServerError({ class: "conflict", code: "workspace_host_offline", message: "Runtime unavailable" })
  const server = fakeServer({ reachable: () => true, runtime: () => { throw failure } })
  const reads = startSessionReads(server.context, ref, shape)
  const results = await Promise.allSettled([reads.first, reads.status, reads.requests, reads.todos, reads.goal, reads.subagents, reads.backgroundWork])
  expect(results[0]?.status).toBe("fulfilled")
  expect(results.slice(1).every((result) => result.status === "rejected" && result.reason === failure)).toBe(true)
  expect(server.requests.filter((path) => path === "/api/claxedo/bootstrap").length).toBeGreaterThanOrEqual(2)
})

test("session reads: a running cloud workspace reads its history from the runtime, which holds the turn its checkpoint has not stored yet", async () => {
  const live = [...stored, { info: { id: "msg_3", sessionID: "ses_1", role: "user", time: { created: 4 } }, parts: [{ id: "prt_4", type: "text", text: "and now?" }] }]
  const olderPage = withQuery(sessionEndpoint(ref, "/page"), { before: "cursor_live", ...viewportQuery(shape) })
  const server = fakeServer({
    reachable: () => true,
    runtime: (path) => {
      if (path === firstPath) return firstRead(undefined, { turns: [{ messages: live, cursor: "cursor_live" }] })
      if (path === olderPage) return Response.json({ turns: [{ messages: stored }] })
      if (path === sessionEndpoint(ref)) return Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2", "msg_3"])
  expect(first.row).toMatchObject({ title: "Live title", updatedAt: 30 })
  expect((await reads.runtime)?.row).toMatchObject({ title: "Live title", updatedAt: 30 })
  expect(await reads.status).toEqual({ kind: "idle" })
  expect(server.requests.filter((path) => path.startsWith("/api/control/")), "the stored copy is not read while the runtime answers").toEqual([])
  expect([...server.runtimeCalls].sort()).toEqual([firstPath, sessionEndpoint(ref), openPath].sort())

  expect((await readTurnPageBefore(server.context, ref, shape, "cursor_live")).entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(server.requests.filter((path) => path.startsWith("/api/control/"))).toEqual([])
})

test("session reads: a running cloud workspace whose runtime no longer has the session reads every page and part from the stored copy", async () => {
  const failure = new ServerError({ class: "not_found", status: 404, code: "session_not_found", message: "Session not found" })
  const server = fakeServer({ reachable: () => true, runtime: () => { throw failure } })
  await readTurnPageBefore(server.context, ref, shape, "cursor_older")
  await readPart(server.context, ref, "msg_2", "prt_3")
  expect(server.requests).toContain("/api/control/sessions/ses_1/page?workspaceId=ws_cloud&before=cursor_older&rows=40&cols=100&reasoning=0&shell=0&edit=0")
  expect(server.requests).toContain("/api/control/sessions/ses_1/part?workspaceId=ws_cloud&messageId=msg_2&partId=prt_3")
})

test("session reads: a cloud session's stored history survives a missing runtime session while live facts remain refused", async () => {
  const failure = new ServerError({ class: "not_found", status: 404, code: "session_not_found", message: "Session not found" })
  const server = fakeServer({ reachable: () => true, runtime: () => { throw failure } })
  const reads = startSessionReads(server.context, ref, shape)
  const [first, ...facts] = await Promise.allSettled([reads.first, reads.status, reads.backgroundWork, reads.requests, reads.todos, reads.goal, reads.subagents])
  expect(first.status).toBe("fulfilled")
  if (first.status === "fulfilled") {
    expect(first.value.row.title).toBe("Ship it")
    expect(first.value.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  }
  for (const fact of facts) expect(fact).toEqual({ status: "rejected", reason: failure })
})

test("session reads: held cloud history reads the control-plane row independently of the runtime", async () => {
  const failure = new ServerError({ class: "not_found", status: 404, code: "session_not_found", message: "Session not found" })
  const server = fakeServer({ reachable: () => true, runtime: () => { throw failure } })
  const held = { latestTurn: { entries: [], olderCursor: "before-latest" }, outline: { turns: [], complete: true } }
  const reads = startSessionReads(server.context, ref, shape, held)
  const results = await Promise.allSettled([reads.first, reads.runtime, reads.status, reads.requests, reads.todos, reads.goal, reads.subagents, reads.backgroundWork])
  expect(results[0]?.status).toBe("fulfilled")
  const first = await reads.first
  expect(first.transcript).toBe(held.latestTurn)
  expect(first.outline).toBe(held.outline)
  expect(first.row.title).toBe("Ship it")
  for (const result of results.slice(1)) expect(result).toEqual({ status: "rejected", reason: failure })
})
