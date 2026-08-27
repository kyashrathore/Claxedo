export type ProcessDaemonLease = Readonly<{
  stop: () => Promise<void>
  shutdown: () => Promise<void>
}>

export function createDaemonExitLifecycle() {
  let intent: "quit" | "handoff" = "quit"

  return {
    handoff() {
      intent = "handoff"
    },
    async release(lease: ProcessDaemonLease | undefined) {
      if (intent === "handoff") await lease?.stop()
      else await lease?.shutdown()
    },
  }
}
