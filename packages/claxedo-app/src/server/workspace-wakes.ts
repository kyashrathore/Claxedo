import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { sleep } from "@claxedo/helpers"
import type { WorkspaceRuntime } from "./cloud-types"
import { toAppError } from "./errors"
import { placementId, type PlacementId } from "./ids"
import { isStoppedCloud } from "./placement-runtime"
import type { Transport } from "./transport"
import { WAKE_IDLE, wakeTransition, type WakeEvent, type WakeState } from "./wake-machine"
import type { Workspaces } from "./workspaces"

export type WorkspaceWakes = {
  readonly runtime: (id: PlacementId) => WorkspaceRuntime
  readonly start: (id: PlacementId) => Promise<void>
  readonly wakeIfStopped: (id: PlacementId) => Promise<boolean>
  readonly settle: (id: PlacementId) => Promise<boolean>
}

const CHECKPOINT_SETTLE_MS = 5_000

function runtimeOf(wake: WakeState, asleep: boolean): WorkspaceRuntime {
  if (wake.kind === "waking") return { kind: "waking", ...(wake.bootMode ? { bootMode: wake.bootMode } : {}) }
  if (wake.kind === "outdated" && !asleep) return { kind: "outdated" }
  if (wake.kind === "failed" && (asleep || wake.restart)) return { kind: "wakeFailed", error: wake.error }
  return asleep ? { kind: "asleep" } : { kind: "live" }
}

async function wakeWorkspace(transport: Transport, workspaces: Workspaces, id: PlacementId, send: (event: WakeEvent) => void) {
  send({ type: "wakeStarted" })
  try {
    const { workspaceId } = await workspaces.locate(id)
    await transport.startRuntime(workspaceId, { onProgress: (progress) => send({ type: "provisioning", ...(progress.bootMode ? { bootMode: progress.bootMode } : {}) }) })
    await workspaces.refresh()
    send({ type: "woke" })
  } catch (cause) {
    send({ type: "wakeFailed", error: toAppError(cause) })
    throw cause
  }
}

export function createWorkspaceWakes(transport: Transport, workspaces: Workspaces, wait: (ms: number) => Promise<void> = sleep): WorkspaceWakes {
  const [wakes, setWakes] = createStore<Record<string, WakeState>>({})
  const send = (id: PlacementId, event: WakeEvent) => setWakes(id, (state) => wakeTransition(state ?? WAKE_IDLE, event))
  const running = new Map<string, Promise<void>>()
  onCleanup(transport.onImageOutdated((workspaceId) => send(placementId(workspaceId), { type: "imageOutdated" })))
  const run = (id: PlacementId) => wakeWorkspace(transport, workspaces, id, (event) => send(id, event)).finally(() => running.delete(id))
  const start = (id: PlacementId) => {
    const current = running.get(id)
    if (current) return current
    const next = run(id)
    running.set(id, next)
    return next
  }
  const wakeIfStopped = async (id: PlacementId) => {
    await workspaces.load()
    if (!isStoppedCloud(workspaces.byId(id))) return false
    await start(id)
    return true
  }
  return {
    runtime: (id) => runtimeOf(wakes[id] ?? WAKE_IDLE, isStoppedCloud(workspaces.byId(id))),
    start,
    wakeIfStopped,
    settle: async (id) => {
      await wait(CHECKPOINT_SETTLE_MS)
      await workspaces.refresh()
      return await wakeIfStopped(id)
    },
  }
}
