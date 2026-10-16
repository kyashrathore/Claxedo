import { createRoot } from "solid-js"
import type { WorkspaceStartProgress } from "../cloud-types"
import type { ServerEvent } from "../events"
import { placementId } from "../ids"
import type { RuntimeRoute, Transport } from "../transport"
import type { Placement } from "../types"
import type { StartOptions } from "../workspace-start"
import { createWorkspaceWakes } from "../workspace-wakes"
import type { Workspaces } from "../workspaces"

export const cloud = placementId("ws_cloud")
export const folder = placementId("ws_folder")

export const NOW = 1_000_000

type Start = { resolve: () => void; reject: (error: unknown) => void }

type Lifecycle = Extract<Placement, { kind: "cloud" }>["lifecycle"]

export type ServerScript = {
  readonly lifecycle?: Lifecycle
  readonly failure?: string
  readonly checkpointUnusable?: true
  readonly startProgress?: readonly WorkspaceStartProgress[]
  readonly startFresh?: () => Promise<unknown>
}

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

function fakeTransport(server: ServerScript) {
  const recorded = {
    requests: [] as { path: string; body: unknown }[],
    starts: [] as Start[],
    follows: [] as Start[],
    settles: [] as NonNullable<StartOptions["settled"]>[],
    images: [] as ((workspaceId: string, outdated: boolean) => void)[],
  }
  const transport = {
    onRuntimeImage: (listener: (workspaceId: string, outdated: boolean) => void) => {
      recorded.images.push(listener)
      return () => undefined
    },
    startRuntime: (_workspaceId: string, options?: StartOptions) => {
      if (options?.settled) recorded.settles.push(options.settled)
      for (const progress of server.startProgress ?? [{ kind: "provisioning", bootMode: "resume" }]) options?.onProgress?.(progress)
      return new Promise<void>((resolve, reject) => recorded.starts.push({ resolve, reject }))
    },
    followRuntime: (_workspaceId: string, options?: StartOptions) => {
      options?.onProgress?.({ kind: "provisioning", bootMode: "cold-start" })
      return new Promise<void>((resolve, reject) => recorded.follows.push({ resolve, reject }))
    },
    json: async (path: string, init?: RequestInit) => {
      recorded.requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      return await (server.startFresh?.() ?? Promise.resolve({ ok: true, status: "stopped" }))
    },
  } as Pick<Transport, "startRuntime" | "followRuntime" | "onRuntimeImage" | "json"> as Transport
  return { transport, recorded }
}

function fakeWorkspaces(running: { value: boolean }, server: ServerScript): Workspaces {
  const placements: Record<string, Placement> = {
    ws_cloud: { id: cloud, projectId: "proj" as Placement["projectId"], kind: "cloud", label: "main", lifecycle: "asleep", reachable: false, onThisMachine: false },
    ws_folder: { id: folder, projectId: "proj" as Placement["projectId"], kind: "folder", label: "repo", reachable: false, onThisMachine: false },
  }
  const lifecycle = (): Lifecycle => (running.value ? "live" : server.lifecycle ?? "asleep")
  const cloudFacts = () => ({ lifecycle: lifecycle(), ...(server.failure ? { failure: server.failure } : {}), ...(server.checkpointUnusable ? { checkpointUnusable: true } : {}) })
  return {
    load: async () => ({ declaration: { serverKind: "daemon", hostAggregate: false, issuesSessions: true, documents: false, connections: false }, placements: [] }),
    byId: (id: string) => ({ ...placements[id], ...(id === "ws_cloud" ? cloudFacts() : {}), reachable: id === "ws_cloud" && running.value }),
    locate: async (id: string): Promise<RuntimeRoute> => ({ directory: `workspace:${id}`, workspaceId: id, remote: true }),
    refresh: async () => undefined,
  } as Pick<Workspaces, "load" | "byId" | "locate" | "refresh"> as Workspaces
}

export function wakesFixture(running: { value: boolean }, server: ServerScript = {}) {
  const { emit, events } = eventFeed()
  const { transport, recorded } = fakeTransport(server)
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms) }
  return { ...recorded, waits, emit, wakes: createRoot(() => createWorkspaceWakes(transport, fakeWorkspaces(running, server), events, wait, () => NOW)) }
}

export async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}
