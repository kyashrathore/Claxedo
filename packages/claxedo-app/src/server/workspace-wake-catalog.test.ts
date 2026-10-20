/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import type { ServerEvent } from "./events"
import { placementId } from "./ids"
import { invalidateFor } from "./queries"
import type { Transport } from "./transport"
import type { StartOptions } from "./workspace-start"
import { createWorkspaceWakes } from "./workspace-wakes"
import { createWorkspaces } from "./workspaces"

const SERVER_URL = "http://127.0.0.1:1"
const cloud = placementId("ws_cloud")

function startedWorld() {
  const status = { current: "stopped" }
  const reads: string[] = []
  const started: { workspaceId: string; finish: () => void }[] = []
  const transport = {
    serverUrl: SERVER_URL,
    loopback: false,
    json: async (path: string) => {
      reads.push(path)
      const row = { id: "ws_cloud", backing: "cloud-vm", workspace_name: "main", directory: "workspace:ws_cloud", status: status.current, reachable: status.current === "ready" }
      return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "proj_one", worktree: "ws_cloud", workspaces: { ws_cloud: row } }] }
    },
    onSessionHost: () => () => undefined,
    onRuntimeImage: () => () => undefined,
    startRuntime: (workspaceId: string, _options?: StartOptions) => new Promise<void>((finish) => started.push({ workspaceId, finish })),
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost" | "onRuntimeImage" | "startRuntime"> as Transport
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const workspaces = createWorkspaces(transport, queryClient)
  const listeners = new Set<(event: ServerEvent) => void>()
  const publish = (event: ServerEvent) => {
    invalidateFor(queryClient, SERVER_URL, event, false)
    for (const listener of listeners) listener(event)
  }
  const events = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const wakes = createWorkspaceWakes(transport, workspaces, events)
  const catalogReads = () => reads.filter((path) => path === "/api/claxedo/bootstrap").length
  const startRequested = async () => {
    for (let tick = 0; tick < 50 && started.length === 0; tick += 1) await Bun.sleep(1)
    return started[0]
  }
  return { status, workspaces, wakes, publish, catalogReads, startRequested }
}

test("a start whose end the server announced takes the catalog that notice re-read, so the workspace reads live after one catalog read", async () => {
  await createRoot(async (dispose) => {
    const { status, workspaces, wakes, publish, catalogReads, startRequested } = startedWorld()
    await workspaces.load()
    expect(wakes.runtime(cloud)).toEqual({ kind: "asleep" })
    const before = catalogReads()

    const waking = wakes.start(cloud)
    const start = await startRequested()
    expect(start?.workspaceId).toBe("ws_cloud")
    status.current = "ready"
    publish({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "ready" } })
    await Bun.sleep(5)
    expect(catalogReads() - before).toBe(1)
    start?.finish()
    await waking

    expect(catalogReads() - before).toBe(1)
    expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
    workspaces.dispose()
    dispose()
  })
})

test("a start no notice announced re-reads the catalog itself once it is up, so it never reads asleep from the catalog it began with", async () => {
  await createRoot(async (dispose) => {
    const { status, workspaces, wakes, catalogReads, startRequested } = startedWorld()
    await workspaces.load()
    const before = catalogReads()

    const waking = wakes.start(cloud)
    const start = await startRequested()
    status.current = "ready"
    start?.finish()
    await waking

    expect(catalogReads() - before).toBe(1)
    expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
    workspaces.dispose()
    dispose()
  })
})

test("a start asks for the workspace its placement names before the catalog lists it, so a create's start need not wait for the create's catalog read", async () => {
  await createRoot(async (dispose) => {
    const { status, workspaces, wakes, catalogReads, startRequested } = startedWorld()
    const fresh = placementId("ws_fresh")

    const waking = wakes.start(fresh)
    const start = await startRequested()
    expect(start?.workspaceId).toBe("ws_fresh")
    expect(catalogReads()).toBe(0)
    status.current = "ready"
    start?.finish()
    await waking
    expect(catalogReads()).toBe(1)
    workspaces.dispose()
    dispose()
  })
})
