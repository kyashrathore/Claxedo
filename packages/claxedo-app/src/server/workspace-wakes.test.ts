/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError } from "./errors"
import { placementId } from "./ids"
import type { Placement } from "./types"
import type { RuntimeRoute, Transport } from "./transport"
import type { StartOptions } from "./workspace-start"
import { createWorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"

const cloud = placementId("ws_cloud")
const folder = placementId("ws_folder")

type Start = { resolve: () => void; reject: (error: unknown) => void }

function fixture(running: { value: boolean }) {
  const starts: Start[] = []
  const placements: Record<string, Placement> = {
    ws_cloud: { id: cloud, projectId: "proj" as Placement["projectId"], kind: "cloud", label: "main", reachable: false, onThisMachine: false },
    ws_folder: { id: folder, projectId: "proj" as Placement["projectId"], kind: "folder", label: "repo", reachable: false, onThisMachine: false },
  }
  const transport = {
    startRuntime: (_workspaceId: string, options?: StartOptions) => {
      options?.onProgress?.({ kind: "provisioning", bootMode: "resume" })
      return new Promise<void>((resolve, reject) => starts.push({ resolve, reject }))
    },
  } as Pick<Transport, "startRuntime"> as Transport
  const workspaces = {
    load: async () => ({ declaration: { serverKind: "daemon", hostAggregate: false, issuesSessions: true, documents: false, connections: false }, placements: [] }),
    byId: (id: string) => ({ ...placements[id], reachable: id === "ws_cloud" && running.value }),
    locate: async (id: string): Promise<RuntimeRoute> => ({ directory: `workspace:${id}`, workspaceId: id, remote: true }),
    refresh: async () => undefined,
  } as Pick<Workspaces, "load" | "byId" | "locate" | "refresh"> as Workspaces
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms) }
  return { starts, waits, wakes: createRoot(() => createWorkspaceWakes(transport, workspaces, wait)) }
}

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

test("wakes: a send to an asleep cloud workspace starts it once, however many sends wait on it, and the workspace reads waking, then live", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  expect(wakes.runtime(cloud)).toEqual({ kind: "asleep" })

  const first = wakes.wakeIfStopped(cloud)
  const second = wakes.wakeIfStopped(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "resume" })

  running.value = true
  starts[0].resolve()
  await Promise.all([first, second])
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a refused start leaves the workspace asleep with the server's reason, and a retry can wake it", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable" })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  starts[0].reject(refusal)
  await expect(send).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })

  const retry = wakes.start(cloud)
  await settle()
  expect(wakes.runtime(cloud).kind).toBe("waking")
  running.value = true
  starts[1].resolve()
  await retry
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a live workspace, or a placement that is not in the cloud, is never started by a send", async () => {
  const running = { value: true }
  const { starts, wakes } = fixture(running)

  await wakes.wakeIfStopped(cloud)
  await wakes.wakeIfStopped(folder)
  expect(starts).toEqual([])
})

test("wakes: settling after a checkpoint waits, then starts a workspace the checkpoint stopped, and leaves a running one alone", async () => {
  const running = { value: true }
  const { starts, waits, wakes } = fixture(running)
  expect(await wakes.settle(cloud)).toBe(false)
  expect(waits).toEqual([5_000])
  running.value = false
  const settling = wakes.settle(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  running.value = true
  starts[0].resolve()
  expect(await settling).toBe(true)
})
