/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId, projectId, sessionId } from "./ids"
import { sessionEndpoint } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { readOlder, readSession } from "./session-reads"
import { createStatusOwner } from "./status"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import { workspaceStopped } from "./wire/connection"
import { createWorkspaces } from "./workspaces"

const ref = { projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") }
const historyPath = withQuery(sessionEndpoint(ref, "/message"), { view: "latest-surface" })

const stored = [
  { info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }, parts: [{ id: "prt_1", type: "text", text: "why?" }] },
  { info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt_2", type: "text", text: "because" }] },
]

const MACHINE_ROW = { backing: "local-worktree", placement: { host_enrollment_id: "enr_laptop" } }

function bootstrap(reachable: () => boolean, machine: boolean) {
  return {
    events: { hostAggregate: false },
    deployment: { issuesSessions: true },
    project: [{
      id: "proj_1",
      worktree: "ws_cloud",
      workspaces: { ws_cloud: { id: "ws_cloud", ...(machine ? MACHINE_ROW : { backing: "cloud-vm" }), reachable: reachable(), directory: "workspace:ws_cloud" } },
    }],
  }
}

function fakeServer(options: { reachable: () => boolean; machine?: boolean; runtime?: (path: string) => Response | Promise<Response> }) {
  const requests: string[] = []
  const runtimeCalls: string[] = []
  const request = async (path: string) => {
    requests.push(path)
    if (path === "/api/claxedo/bootstrap") return Response.json(bootstrap(options.reachable, options.machine ?? false))
    if (path.startsWith("/api/control/sessions/ses_1/messages")) return Response.json({ messages: stored, maxEventOrdinal: 0 }, { headers: { "X-Next-Cursor": "cursor_older" } })
    if (path.startsWith("/api/control/sessions?")) return Response.json({ sessions: [{ session_id: "ses_1", title: "Ship it", created_at: 10, updated_at: 20, last_human_turn_at: 15 }] })
    return Response.json({ error: { code: "unexpected", message: path } }, { status: 500 })
  }
  const runtime = async (_route: RuntimeRoute, path: string) => {
    runtimeCalls.push(path)
    return options.runtime ? options.runtime(path) : Response.json({ error: { message: "unexpected runtime read" } }, { status: 500 })
  }
  const readJson = async <T>(response: Response) => (await response.json()) as T
  const transport = {
    serverUrl: "https://cp.test",
    loopback: false,
    request,
    runtime,
    runtimeSocket: async () => {
      throw new Error("no sockets")
    },
    json: async <T>(path: string) => readJson<T>(await request(path)),
    runtimeJson: async <T>(route: RuntimeRoute, path: string) => {
      const response = await runtime(route, path)
      if (response.status === 409) throw workspaceStopped("ws_cloud")
      return readJson<T>(response)
    },
    startRuntime: async () => undefined,
  } satisfies Transport
  const workspaces = createWorkspaces(transport, new QueryClient())
  return { context: { transport, workspaces, status: createStatusOwner(transport) }, requests, runtimeCalls }
}

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
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&view=latest-surface")
  expect(server.runtimeCalls).toEqual([])

  await readOlder(server.context, ref, "cursor_older")
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&limit=50&before=cursor_older")
  expect(server.runtimeCalls).toEqual([])
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
  expect(server.requests.filter((path) => path === "/api/claxedo/bootstrap").length).toBeGreaterThanOrEqual(2)
})

test("session reads: a running cloud workspace's session still reads its history from the control plane; its row and runtime facts from the sandbox", async () => {
  const server = fakeServer({
    reachable: () => true,
    runtime: (path) => {
      if (path === "/session/ses_1") return Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
      if (path === "/session/status") return Response.json({})
      if (path.startsWith("/permission") || path.startsWith("/question") || path.endsWith("/todo")) return Response.json([])
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = readSession(server.context, ref)

  const surface = await reads.surface
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
    const server = fakeServer({
      reachable: () => true,
      machine,
      runtime: (path) => {
        if (path === "/session/ses_1") return metadata.promise
        if (path === historyPath) return Response.json(stored)
        return Response.json([])
      },
    })
    const reads = readSession(server.context, ref)
    let landed = false
    const surface = reads.surface.then((value) => { landed = true; return value })
    await Promise.all([reads.requests, reads.todos, reads.goal])
    try {
      expect(landed).toBe(false)
      expect(machine ? server.runtimeCalls : server.requests).toContain(machine
        ? historyPath
        : "/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&view=latest-surface")
    } finally {
      metadata.resolve(Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } }))
      await Promise.all([surface, reads.status])
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
        if (path === "/session/ses_1") return failedRead === "metadata"
          ? Promise.reject(failure)
          : Response.json({ id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } })
        if (path === historyPath) return failedRead === "history" ? Promise.reject(failure) : Response.json(stored)
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
  const results = await Promise.allSettled([reads.surface, reads.status, reads.requests, reads.todos, reads.goal])
  for (const result of results) expect(result).toEqual({ status: "rejected", reason: failure })
})
