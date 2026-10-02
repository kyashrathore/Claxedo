export type ProcessDaemonLease = Readonly<{
  stop: () => Promise<void>
}>

export function createDaemonExitLifecycle() {
  return {
    async release(lease: ProcessDaemonLease | undefined) {
      // Desktop lifetime owns only this lease. The daemon owns running work
      // and exits through its idle grace once all owners release residency.
      await lease?.stop()
    },
  }
}
