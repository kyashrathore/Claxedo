import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { sleep } from "@claxedo/helpers"
import type { CloudWorkspaceStatus, WorkspaceRuntime, WorkspaceStartProgress } from "./cloud-types"
import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import { placementId, type PlacementId } from "./ids"
import { isStartingCloud, isStoppedCloud } from "./placement-runtime"
import type { Transport } from "./transport"
import type { Placement } from "./types"
import { WAKE_IDLE, wakeTransition, type WakeEvent, type WakeState } from "./wake-machine"
import type { Workspaces } from "./workspaces"

export type WorkspaceWakes = {
  readonly runtime: (id: PlacementId) => WorkspaceRuntime
  readonly start: (id: PlacementId) => Promise<void>
  readonly follow: (id: PlacementId) => Promise<void>
  readonly wakeIfStopped: (id: PlacementId) => Promise<boolean>
  readonly settle: (id: PlacementId) => Promise<boolean>
}

const CHECKPOINT_SETTLE_MS = 5_000

function runtimeOf(wake: WakeState, placement: Placement | undefined): WorkspaceRuntime {
  const asleep = isStoppedCloud(placement)
  if (wake.kind === "waking") {
    const { restart: _restart, ...waking } = wake
    return waking
  }
  if (wake.kind === "outdated" && !asleep) return { kind: "outdated" }
  if (wake.kind === "failed" && (asleep || wake.restart)) return { kind: "wakeFailed", error: wake.error }
  if (isStartingCloud(placement)) return { kind: "waking", followed: true }
  return asleep ? { kind: "asleep" } : { kind: "live" }
}

const START_ENDS: ReadonlySet<CloudWorkspaceStatus["kind"]> = new Set(["ready", "stopped", "failed"])

type StartSettled = (listener: () => void) => () => void

type Run = (workspaceId: string, options: { onProgress: (progress: WorkspaceStartProgress) => void; settled: StartSettled }) => Promise<void>

type ServerEvents = (listener: (event: ServerEvent) => void) => () => void

function startSettled(events: ServerEvents, id: PlacementId): StartSettled {
  return (listener) => events((event) => {
    if (event.type === "cloudWorkspaceChanged" && event.workspaceId === id && START_ENDS.has(event.status.kind)) listener()
  })
}

async function driveWake(run: Run, followed: boolean, workspaces: Workspaces, id: PlacementId, settled: StartSettled, send: (event: WakeEvent) => void) {
  send({ type: "wakeStarted", ...(followed ? { followed: true } : {}) })
  try {
    const { workspaceId } = await workspaces.locate(id)
    await run(workspaceId, { onProgress: ({ kind: _kind, ...progress }) => send({ type: "provisioning", ...progress }), settled })
    await workspaces.refresh()
    send({ type: "woke" })
  } catch (cause) {
    send({ type: "wakeFailed", error: toAppError(cause) })
    throw cause
  }
}

export function createWorkspaceWakes(transport: Transport, workspaces: Workspaces, events: ServerEvents, wait: (ms: number) => Promise<void> = sleep): WorkspaceWakes {
  const [wakes, setWakes] = createStore<Record<string, WakeState>>({})
  const send = (id: PlacementId, event: WakeEvent) => setWakes(id, (state) => wakeTransition(state ?? WAKE_IDLE, event))
  const running = new Map<string, Promise<void>>()
  onCleanup(transport.onRuntimeImage((workspaceId, outdated) => send(placementId(workspaceId), { type: outdated ? "imageOutdated" : "imageCurrent" })))
  const drive = (id: PlacementId, run: Run, followed: boolean) => {
    const current = running.get(id)
    if (current) return current
    const next = driveWake(run, followed, workspaces, id, startSettled(events, id), (event) => send(id, event)).finally(() => running.delete(id))
    running.set(id, next)
    return next
  }
  const start = (id: PlacementId) => drive(id, transport.startRuntime, false)
  const wakeIfStopped = async (id: PlacementId) => {
    await workspaces.load()
    if (!isStoppedCloud(workspaces.byId(id))) return false
    await start(id)
    return true
  }
  return {
    runtime: (id) => runtimeOf(wakes[id] ?? WAKE_IDLE, workspaces.byId(id)),
    start,
    follow: async (id) => {
      if (!isStartingCloud(workspaces.byId(id))) return
      await drive(id, transport.followRuntime, true).catch((error: unknown) => console.warn("A start the server is driving could not be followed", { placementId: id, error: toAppError(error) }))
    },
    wakeIfStopped,
    settle: async (id) => {
      await wait(CHECKPOINT_SETTLE_MS)
      await workspaces.refresh()
      return await wakeIfStopped(id)
    },
  }
}
