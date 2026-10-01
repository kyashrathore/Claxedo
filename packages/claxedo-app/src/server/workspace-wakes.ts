import { createStore } from "solid-js/store"
import type { WorkspaceRuntime } from "./cloud-types"
import { toAppError } from "./errors"
import type { PlacementId } from "./ids"
import { isStoppedCloud } from "./placement-runtime"
import type { Transport } from "./transport"
import { WAKE_IDLE, wakeTransition, type WakeEvent, type WakeState } from "./wake-machine"
import type { Workspaces } from "./workspaces"

export type WorkspaceWakes = {
  readonly runtime: (id: PlacementId) => WorkspaceRuntime
  readonly start: (id: PlacementId) => Promise<void>
  readonly wakeIfStopped: (id: PlacementId) => Promise<void>
}

function runtimeOf(wake: WakeState, asleep: boolean): WorkspaceRuntime {
  if (wake.kind === "waking") return { kind: "waking", ...(wake.bootMode ? { bootMode: wake.bootMode } : {}) }
  if (wake.kind === "failed" && asleep) return { kind: "wakeFailed", error: wake.error }
  return asleep ? { kind: "asleep" } : { kind: "live" }
}

export function createWorkspaceWakes(transport: Transport, workspaces: Workspaces): WorkspaceWakes {
  const [wakes, setWakes] = createStore<Record<string, WakeState>>({})
  const send = (id: PlacementId, event: WakeEvent) => setWakes(id, (state) => wakeTransition(state ?? WAKE_IDLE, event))
  const running = new Map<string, Promise<void>>()
  const run = async (id: PlacementId) => {
    send(id, { type: "wakeStarted" })
    try {
      const route = await workspaces.locate(id)
      await transport.startRuntime(route, { onProgress: (progress) => send(id, { type: "provisioning", ...(progress.bootMode ? { bootMode: progress.bootMode } : {}) }) })
      await workspaces.refresh()
      send(id, { type: "woke" })
    } catch (cause) {
      send(id, { type: "wakeFailed", error: toAppError(cause) })
      throw cause
    } finally {
      running.delete(id)
    }
  }
  const start = (id: PlacementId) => {
    const current = running.get(id)
    if (current) return current
    const next = run(id)
    running.set(id, next)
    return next
  }
  return {
    runtime: (id) => runtimeOf(wakes[id] ?? WAKE_IDLE, isStoppedCloud(workspaces.byId(id))),
    start,
    wakeIfStopped: async (id) => {
      await workspaces.load()
      if (isStoppedCloud(workspaces.byId(id))) await start(id)
    },
  }
}
