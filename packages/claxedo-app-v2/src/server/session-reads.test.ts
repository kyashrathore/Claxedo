/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId, projectId, sessionId } from "./ids"
import { NO_GOAL } from "./session-goal"
import { readOlder, readSession } from "./session-reads"
import { createStatusOwner } from "./status"
import type { RuntimeRoute, Transport } from "./transport"
import { workspaceStopped } from "./wire/connection"
import { createWorkspaces } from "./workspaces"

const ref = { projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") }

const stored = [
  { info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }, parts: [{ id: "prt_1", type: "text", text: "why?" }] },
  { info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt_2", type: "text", text: "because" }] },
]

function bootstrap(reachable: () => boolean) {
  return {
    events: { hostAggregate: false },
    deployment: { issuesSessions: true },
    project: [{ id: "proj_1", worktree: "ws_cloud", workspaces: { ws_cloud: { id: "ws_cloud", backing: "cloud-vm", reachable: reachable(), directory: "workspace:ws_cloud" } } }],
  }
}

function fakeServer(options: { reachable: () => boolean; runtime?: (path: string) => Response }) {
  const requests: string[] = []
  const runtimeCalls: string[] = []
  const request = async (path: string) => {
    requests.push(path)
    if (path === "/api/claxedo/bootstrap") return Response.json(bootstrap(options.reachable))
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
  expect(server.requests).toContain("/api/control/sessions/ses_1/messages?workspaceId=ws_cloud&limit=50")
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
