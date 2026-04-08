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

export type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
}

export type ClaxedoEvent =
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

export const claxedoBus = createBus<ClaxedoEvent>()
