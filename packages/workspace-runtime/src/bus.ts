import type { SessionLifecycleEvent } from "./routes/session-core"

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
      console.error("workspaceRuntimeBus subscriber failed", error)
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

export type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
}

export type WorkspaceRuntimeEvent =
  | { type: "pty.created"; info: PtyInfo }
  | { type: "pty.updated"; info: PtyInfo }
  | { type: "pty.exited"; id: string; exitCode: number; tail?: string }
  | { type: "pty.deleted"; id: string }
  | {
      type: "pty.stream"
      id: string
      kind: "data" | "exit" | "disconnect" | "error" | "command-exit"
      exitCode?: number
      message?: string
      tail?: string
    }
  | {
      type: "agent.lifecycle"
      tabId: string
      terminalId?: string
      workspaceId?: string
      provider?: string
      sessionId?: string
      transcriptPath?: string
      refName?: string
      prompt?: string
      lastAssistantMessage?: string
      eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"
    }
  | { type: "heartbeat" }
  | { type: "process.started"; directory: string; configId: string; ptyId: string }
  | { type: "process.stopped"; directory: string; configId: string; exitCode: number }
  | { type: "process.crashed"; directory: string; configId: string; exitCode: number; restartCount: number; commandExit?: boolean; ptyId?: string }
  | { type: "process.status"; directory: string; configId: string; status: string }
  | { type: "process.config.changed"; directory: string; configs: unknown[] }
  | SessionLifecycleEvent

type RuntimeBus = ReturnType<typeof createBus<WorkspaceRuntimeEvent>>

// Each public dist entry (index/host/routes/…) is bundled separately, so this
// module is instantiated once per entry in the same process. Pin the bus on
// globalThis so publishers in one bundle reach subscribers in another.
const globalBusKey = Symbol.for("claxedo.workspace-runtime.bus")
const globalBusStore = globalThis as Record<PropertyKey, unknown>
export const workspaceRuntimeBus: RuntimeBus =
  (globalBusStore[globalBusKey] as RuntimeBus | undefined) ??
  (globalBusStore[globalBusKey] = createBus<WorkspaceRuntimeEvent>())

/** @deprecated Use {@link WorkspaceRuntimeEvent}; product-branded alias kept for compatibility. */
export type ClaxedoEvent = WorkspaceRuntimeEvent

/** @deprecated Use {@link workspaceRuntimeBus}; product-branded alias kept for compatibility. */
export const claxedoBus = workspaceRuntimeBus
