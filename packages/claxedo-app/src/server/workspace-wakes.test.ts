/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError } from "./errors"
import { placementId } from "./ids"
import type { Placement } from "./types"
import type { ServerEvent } from "./events"
import type { RuntimeRoute, Transport } from "./transport"
import type { WorkspaceStartProgress } from "./cloud-types"
import type { StartOptions } from "./workspace-start"
import { createWorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"

const cloud = placementId("ws_cloud")
const folder = placementId("ws_folder")

type Start = { resolve: () => void; reject: (error: unknown) => void }

type Lifecycle = Extract<Placement, { kind: "cloud" }>["lifecycle"]

function eventFeed() {
  const listeners = new Set<(event: ServerEvent) => void>()
  return {
    emit: (event: ServerEvent) => listeners.forEach((listener) => listener(event)),
    events: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

const NOW = 1_000_000

function fixture(running: { value: boolean }, server: { lifecycle?: Lifecycle; failure?: string; startProgress?: readonly WorkspaceStartProgress[] } = {}) {
  const starts: Start[] = []
  const follows: Start[] = []
  const settles: NonNullable<StartOptions["settled"]>[] = []
  const { emit, events } = eventFeed()
  const placements: Record<string, Placement> = {
    ws_cloud: { id: cloud, projectId: "proj" as Placement["projectId"], kind: "cloud", label: "main", lifecycle: "asleep", reachable: false, onThisMachine: false },
    ws_folder: { id: folder, projectId: "proj" as Placement["projectId"], kind: "folder", label: "repo", reachable: false, onThisMachine: false },
  }
  const images: ((workspaceId: string, outdated: boolean) => void)[] = []
  const transport = {
    onRuntimeImage: (listener: (workspaceId: string, outdated: boolean) => void) => {
      images.push(listener)
      return () => undefined
    },
    startRuntime: (_workspaceId: string, options?: StartOptions) => {
      if (options?.settled) settles.push(options.settled)
      for (const progress of server.startProgress ?? [{ kind: "provisioning", bootMode: "resume" }]) options?.onProgress?.(progress)
      return new Promise<void>((resolve, reject) => starts.push({ resolve, reject }))
    },
    followRuntime: (_workspaceId: string, options?: StartOptions) => {
      options?.onProgress?.({ kind: "provisioning", bootMode: "cold-start" })
      return new Promise<void>((resolve, reject) => follows.push({ resolve, reject }))
    },
  } as Pick<Transport, "startRuntime" | "followRuntime" | "onRuntimeImage"> as Transport
  const lifecycle = (): Lifecycle => (running.value ? "live" : server.lifecycle ?? "asleep")
  const workspaces = {
    load: async () => ({ declaration: { serverKind: "daemon", hostAggregate: false, issuesSessions: true, documents: false, connections: false }, placements: [] }),
    byId: (id: string) => ({ ...placements[id], ...(id === "ws_cloud" ? { lifecycle: lifecycle(), ...(server.failure ? { failure: server.failure } : {}) } : {}), reachable: id === "ws_cloud" && running.value }),
    locate: async (id: string): Promise<RuntimeRoute> => ({ directory: `workspace:${id}`, workspaceId: id, remote: true }),
    refresh: async () => undefined,
  } as Pick<Workspaces, "load" | "byId" | "locate" | "refresh"> as Workspaces
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms) }
  return { starts, follows, waits, images, settles, emit, wakes: createRoot(() => createWorkspaceWakes(transport, workspaces, events, wait, () => NOW)) }
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

test("wakes: Wake clicked twice, and Wake now in the picker beside it, run one start", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)

  const clicks = [wakes.start(cloud), wakes.start(cloud), wakes.start(cloud)]
  await settle()
  expect(starts).toHaveLength(1)

  running.value = true
  starts[0].resolve()
  await Promise.all(clicks)
  expect(starts).toHaveLength(1)
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

test("wakes: a workspace the server is starting reads waking before anything here follows it, and a send joins that start instead of reading it asleep", async () => {
  const running = { value: false }
  const server: { lifecycle?: Lifecycle } = { lifecycle: "starting" }
  const { starts, wakes } = fixture(running, server)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", followed: true })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  running.value = true
  starts[0].resolve()
  expect(await send).toBe(true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: following a start the server is driving reads the connection until the server is done, once however many views ask, and the workspace then reads as the catalog says", async () => {
  const running = { value: false }
  const server: { lifecycle?: Lifecycle } = { lifecycle: "starting" }
  const { starts, follows, wakes } = fixture(running, server)

  const first = wakes.follow(cloud)
  const second = wakes.follow(cloud)
  await settle()
  expect(follows).toHaveLength(1)
  expect(starts).toHaveLength(0)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "cold-start", followed: true })

  running.value = true
  follows[0].resolve()
  await Promise.all([first, second])
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })

  running.value = false
  server.lifecycle = "starting"
  const again = wakes.follow(cloud)
  await settle()
  server.lifecycle = "asleep"
  follows[1].resolve()
  await again
  expect(wakes.runtime(cloud)).toEqual({ kind: "asleep" })
})

test("wakes: a follow that cannot read the server leaves the reason and Try again, and following a workspace nobody is starting does nothing", async () => {
  const running = { value: false }
  const server: { lifecycle?: Lifecycle } = { lifecycle: "starting" }
  const { follows, wakes } = fixture(running, server)
  const lost = new ServerError({ class: "network", message: "The connection read failed" })

  const following = wakes.follow(cloud)
  await settle()
  follows[0].reject(lost)
  await following
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: lost })

  server.lifecycle = "asleep"
  const { follows: idle, wakes: asleep } = fixture(running, server)
  await asleep.follow(cloud)
  expect(idle).toHaveLength(0)
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

test("a running workspace on an older image reads outdated, and Restart to update runs the start that brings it back live", async () => {
  const running = { value: true }
  const { starts, images, wakes } = fixture(running)
  for (const announce of images) announce("ws_cloud", true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "outdated" })
  const restart = wakes.start(cloud)
  expect(wakes.runtime(cloud).kind).toBe("waking")
  await settle()
  starts[0]?.resolve()
  await restart
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("a failed Restart to update keeps its reason and Try again on the running workspace, and an image announcement does not hide it", async () => {
  const running = { value: true }
  const { starts, images, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "No capacity for the new image" })
  for (const announce of images) announce("ws_cloud", true)
  const restart = wakes.start(cloud)
  await settle()
  starts[0]?.reject(refusal)
  await expect(restart).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })
  for (const announce of images) announce("ws_cloud", true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })
  const retry = wakes.start(cloud)
  await settle()
  starts[1]?.resolve()
  await retry
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a start the server retries after a failed step reads waking with that failure", async () => {
  const { starts, wakes } = fixture({ value: false }, { startProgress: [{ kind: "provisioning", bootMode: "resume" }, { kind: "provisioning", failure: "quota exceeded" }] })
  void wakes.start(cloud)
  await settle()
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "resume", failure: "quota exceeded" })
  starts[0].resolve()
  await settle()
})

test("wakes: the start it runs hears the server's notice that this workspace's start ended, and no other workspace's or a start still in progress", async () => {
  const { settles, emit, wakes } = fixture({ value: false })
  void wakes.start(cloud)
  await settle()
  const heard: string[] = []
  const stop = settles[0](() => heard.push("settled"))

  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "provisioning", step: "starting" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: folder, status: { kind: "ready" } })
  emit({ type: "placementsChanged" })
  expect(heard).toEqual([])

  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "ready" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "failed", reason: "boot failed" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "stopped" } })
  expect(heard).toEqual(["settled", "settled", "settled"])

  stop()
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "ready" } })
  expect(heard).toHaveLength(3)
})

test("wakes: a start the server refused until a retry time reads failed with its reason and that time, and nothing asks again on its own", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "Boat POST /sandboxes was rejected (rate_limited)", details: { retryAfterMs: 484_180 } })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  starts[0].reject(refusal)
  await expect(send).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal, retryAt: NOW + 484_180 })
  expect(starts).toHaveLength(1)
})

test("wakes: after a reload, a workspace whose start failed reads failed with the reason the catalog names, not asleep", () => {
  const { wakes } = fixture({ value: false }, { lifecycle: "failed", failure: "Boat's daily start limit (200) is used up; try again later." })
  const runtime = wakes.runtime(cloud)
  expect(runtime.kind).toBe("wakeFailed")
  expect(runtime.kind === "wakeFailed" && runtime.error.message).toBe("Boat's daily start limit (200) is used up; try again later.")
})
