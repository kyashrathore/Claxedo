export type ProcessDaemonLease = Readonly<{
  stop: () => Promise<void>
  drain: () => Promise<void>
}>

export function createDaemonExitLifecycle() {
  let intent: "quit" | "handoff" = "quit"

  return {
    handoff() {
      intent = "handoff"
    },
    async release(lease: ProcessDaemonLease | undefined) {
      // A handoff releases the lease and leaves the daemon for the relaunch to
      // find. A quit asks it to drain, which is the difference between "this
      // app is done with it" and "nothing is coming back for it".
      if (intent === "handoff") await lease?.stop()
      else await lease?.drain()
    },
  }
}
