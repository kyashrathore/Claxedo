import { workspaceRuntimeBus as runtimeBus, type WorkspaceRuntimeEvent as RuntimeClaxedoEvent, type PtyInfo } from "@claxedo/workspace-runtime/host"

type Subscriber<T> = (event: T) => unknown

type BusOptions<T> = {
  onSubscriberError?: (error: unknown, event: T) => void
}

function catches(value: unknown): value is Promise<unknown> {
  return typeof (value as { catch?: unknown } | null)?.catch === "function"
}

export function createBus<T>(options: BusOptions<T> = {}) {
  const subs = new Set<Subscriber<T>>()

  function report(error: unknown, event: T) {
    try {
      if (options.onSubscriberError) {
        options.onSubscriberError(error, event)
        return
      }
      console.error("claxedoBus subscriber failed", error)
    } catch {}
  }

  return {
    publish(event: T) {
      subs.forEach((fn) => {
        try {
          const result = fn(event)
          if (catches(result)) void result.catch((error) => report(error, event))
        } catch (error) {
          report(error, event)
        }
      })
    },
    subscribe(fn: Subscriber<T>) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export type { PtyInfo }

// Canonical session.lifecycle envelope (rubric D4). The frontend re-exports
// this from `shared/claxedo-client` so consumers (event reducer, the create
// wrapper, the ClaxedoEvents provider) share one type definition.
export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  directory: string
  sessionID?: string
  workspaceId?: string
  draftId?: string
  info?: unknown
  message?: string
  ts: number
}

type ControlEvent =
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | SessionLifecycleEvent

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
