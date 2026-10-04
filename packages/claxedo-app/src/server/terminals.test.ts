/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId } from "./ids"
import { createTerminalsApi } from "./terminals"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const relayed = placementId("ws_remote")
const local = placementId("ws_local")

function world() {
  const bodies: Array<Record<string, unknown>> = []
  const transport = {
    serverUrl: "http://127.0.0.1:4096",
    runtimeJson: async (_route: unknown, _path: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("The terminal write carried no JSON body")
      const body = JSON.parse(init.body) as Record<string, unknown>
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

test("a terminal on a placement reached over the relay is the workspace's: it is created with no session", async () => {
  const { api, bodies } = world()
  await api.create({ placementId: relayed, title: "Shell", createRequestId: "c1" })
  await api.create({ placementId: local, title: "Shell", createRequestId: "c2" })
  expect(bodies.map((body) => body.sessionId)).toEqual([undefined, undefined])
  expect(bodies.map((body) => body.createRequestId)).toEqual(["c1", "c2"])
})
