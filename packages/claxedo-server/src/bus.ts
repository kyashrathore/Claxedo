import { claxedoBus as runtimeBus, type ClaxedoEvent as RuntimeClaxedoEvent, type PtyInfo } from "../../workspace-runtime/src/bus"

type Subscriber<T> = (event: T) => void

export function createBus<T>() {
  const subs = new Set<Subscriber<T>>()
  return {
    publish(event: T) {
      subs.forEach((fn) => fn(event))
    },
    subscribe(fn: Subscriber<T>) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export type { PtyInfo }

type ControlEvent =
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "uploading_runtime" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }

export type ClaxedoEvent = RuntimeClaxedoEvent | ControlEvent

export const claxedoBus = runtimeBus as {
  publish(event: ClaxedoEvent): void
  subscribe(fn: Subscriber<ClaxedoEvent>): () => void
}

export type OpenCodeEvent = {
  type: string
  properties?: Record<string, unknown>
}

export type GlobalEvent = {
  directory?: string
  payload: OpenCodeEvent
}

export const globalBus = createBus<GlobalEvent>()
