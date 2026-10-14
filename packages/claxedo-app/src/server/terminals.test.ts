/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId } from "./ids"
import { createTerminalsApi } from "./terminals"
import type { ProductEvent } from "@claxedo/account-contract/product-events"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const relayed = placementId("ws_remote")
const local = placementId("ws_local")

function world(stopped: ReadonlySet<string> = new Set()) {
  const bodies: Array<Record<string, unknown>> = []
  const recorded: ProductEvent[] = []
  const steps: string[] = []
  const asleep = new Set(stopped)
  const transport = {
    serverUrl: "http://127.0.0.1:4096",
    runtimeJson: async (_route: unknown, _path: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("The terminal write carried no JSON body")
      const body = JSON.parse(init.body) as Record<string, unknown>
      bodies.push(body)
      steps.push("pty")
      return { id: "pty_1", title: body.title, status: "running", ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}) }
    },
  } as unknown as Transport
  const record = (id: string) => ({ placement: { id }, route: { directory: `workspace:${id}`, workspaceId: id, remote: id === relayed } })
  const workspaces = {
    route: async (id: string) => {
      if (asleep.has(id)) throw new Error(`workspace ${id} is stopped`)
      return record(id).route
    },
    catalog: () => ({ projects: [], placements: [record(relayed), record(local)] }),
  } as unknown as Workspaces
  const wakes = {
    wakeIfStopped: async (id: string) => {
      steps.push(`wake:${id}`)
      return asleep.delete(id)
    },
  }
  return { api: createTerminalsApi(transport, workspaces, { record: (event) => void recorded.push(event) }, wakes), bodies, recorded, steps }
}

test("a terminal on a placement reached over the relay is the workspace's: it is created with no session", async () => {
  const { api, bodies, recorded } = world()
  await api.create({ placementId: relayed, title: "Shell", createRequestId: "c1" })
  await api.create({ placementId: local, title: "Shell", createRequestId: "c2" })
  expect(bodies.map((body) => body.sessionId)).toEqual([undefined, undefined])
  expect(recorded).toEqual([{ event: "feature_used", properties: { feature: "terminal" } }, { event: "feature_used", properties: { feature: "terminal" } }])
  expect(bodies.map((body) => body.createRequestId)).toEqual(["c1", "c2"])
})

test("a terminal on a stopped cloud workspace wakes it first, then creates the shell on the woken runtime", async () => {
  const { api, bodies, steps } = world(new Set([relayed]))
  await api.create({ placementId: relayed, title: "Shell", createRequestId: "c3" })
  expect(steps).toEqual([`wake:${relayed}`, "pty"])
  expect(bodies.map((body) => body.createRequestId)).toEqual(["c3"])
})
