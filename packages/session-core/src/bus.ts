import type { SessionLifecycleEvent } from "./routes/session-route-options"
import type { QueuedPromptView } from "./session/delivery-owner"
import { asRecord } from "@claxedo/helpers/guards"

type Subscriber<T> = (event: T) => unknown

type BusOptions<T> = {
  onSubscriberError?: (error: unknown, event: T) => void
}

function catches(value: unknown): value is Promise<unknown> {
  return typeof asRecord(value)?.catch === "function"
}

export function createBus<T>(options: BusOptions<T> = {}) {
  const subs = new Set<Subscriber<T>>()

  function report(error: unknown, event: T) {
    try {
      if (options.onSubscriberError) {
        options.onSubscriberError(error, event)
        return
      }
      console.error("Runtime bus subscriber failed", error)
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
  sessionId?: string
  createRequestId?: string
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
  | { type: "pty.exited"; id: string; sessionId?: string; exitCode: number; tail?: string }
  | { type: "pty.deleted"; id: string; sessionId?: string }
  | {
      type: "pty.stream"
      id: string
      sessionId?: string
      kind: "data" | "exit" | "disconnect" | "error"
      exitCode?: number
      message?: string
      tail?: string
    }
  | {
      type: "agent.lifecycle"
      tabId: string
      terminalId?: string
      workspaceId?: string
      directory?: string
      provider?: string
      /** Provider-native agent id; never accepted as private-session scope. */
      providerSessionId?: string
      sessionId?: string
      transcriptPath?: string
      refName?: string
      prompt?: string
      lastAssistantMessage?: string
      eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"
      outcome?: "done" | "error" | "cancelled"
    }
  /** A session's whole queue as it stands after a write changed it. */
  | { type: "session.queue"; directory: string; sessionID: string; queue: QueuedPromptView[] }
  | SessionLifecycleEvent

export type RuntimeBus = ReturnType<typeof createBus<WorkspaceRuntimeEvent>>
