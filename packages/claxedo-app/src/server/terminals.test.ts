/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, sessionId } from "./ids"
import { createTerminalsApi, isTerminalSessionRequired } from "./terminals"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const relayed = placementId("ws_remote")
const local = placementId("ws_local")

function world() {
  const bodies: Array<Record<string, unknown>> = []
  const transport = {
    serverUrl: "http://127.0.0.1:4096",
    runtimeJson: async (_route: unknown, _path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return { id: "pty_1", title: body.title, status: "running", ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}) }
    },
  } as unknown as Transport
  const record = (id: string) => ({ placement: { id }, route: { directory: `workspace:${id}`, workspaceId: id, remote: id === relayed } })
  const workspaces = {
    route: async (id: string) => record(id).route,
    catalog: () => ({ projects: [], placements: [record(relayed), record(local)] }),
  } as unknown as Workspaces
  return { api: createTerminalsApi(transport, workspaces), bodies }
}

test("a terminal on a placement reached over the relay carries the session open in the route", async () => {
  const { api, bodies } = world()
  await api.create({ placementId: relayed, title: "Shell", createRequestId: "c1", openSessionId: sessionId("ses_open") })
  expect(bodies.map((body) => body.sessionId)).toEqual(["ses_open"])
})

test("a terminal on a placement reached over the relay with no session open is refused before anything is sent", async () => {
  const { api, bodies } = world()
  const outcome = await api.create({ placementId: relayed, title: "Shell", createRequestId: "c2" })
    .then(() => "created", (error: unknown) => (isTerminalSessionRequired(error) ? "session required" : "another refusal"))
  expect(outcome).toBe("session required")
  expect(bodies).toEqual([])
})

test("a terminal on this machine's own placement is created as before, with no session", async () => {
  const { api, bodies } = world()
  await api.create({ placementId: local, title: "Shell", createRequestId: "c3", openSessionId: sessionId("ses_open") })
  await api.create({ placementId: local, title: "Shell", createRequestId: "c4" })
  expect(bodies.map((body) => body.sessionId)).toEqual([undefined, undefined])
})

test("a placement reached over the relay requires an open session before a terminal is asked for; this machine's does not", () => {
  const { api } = world()
  expect(api.requiresOpenSession(relayed)).toBe(true)
  expect(api.requiresOpenSession(local)).toBe(false)
})
