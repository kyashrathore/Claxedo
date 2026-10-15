import type { SandboxLease } from "./contract"

/**
 * The lease transitions a deployment meters. A lease epoch is one boot: a wake
 * acquires a new epoch with its own start, so `activeMs` (the epoch's start to
 * its stop or destroy) is the machine time that boot spent, and is present only
 * when the lease was serving at that moment. A destroyed epoch is `hostGone`
 * when the provider lost its host, rather than Claxedo destroying it. A failed
 * epoch whose start goes
 * on in the next epoch is `retrying`; the start the person waits on has not
 * failed until an epoch fails without one.
 */
export type SandboxLifecycleEvent = {
  workspaceId: string
  epoch: number
  driver: string
  labels: Record<string, string>
} & (
  | { kind: "stopped"; idle: boolean; activeMs?: number }
  | { kind: "destroyed"; hostGone: boolean; activeMs?: number }
  | { kind: "failed"; bootFailed: boolean; retrying: boolean }
)

export function createLifecycleReporter(sink: ((event: SandboxLifecycleEvent) => void) | undefined, now: () => number) {
  const base = (lease: SandboxLease) => ({ workspaceId: lease.workspaceId, epoch: lease.epoch, driver: lease.driver, labels: lease.labels ?? {} })
  const active = (lease: SandboxLease, endedAt = now()) =>
    lease.status === "ready" && lease.start ? { activeMs: Math.max(0, endedAt - lease.start.startedAt) } : {}
  const report = (event: SandboxLifecycleEvent) => {
    try {
      sink?.(event)
    } catch {
      // A lifecycle sink observes the transition; it is never part of it.
    }
  }
  return {
    stopped: (lease: SandboxLease, idle: boolean) => report({ ...base(lease), kind: "stopped", idle, ...active(lease) }),
    destroyed: (lease: SandboxLease) => report({ ...base(lease), kind: "destroyed", hostGone: false, ...active(lease) }),
    /** `endedAt` is when the host was last proven serving: the provider's loss is learned after the fact. */
    hostGone: (lease: SandboxLease, endedAt?: number) => report({ ...base(lease), kind: "destroyed", hostGone: true, ...active(lease, endedAt) }),
    failed: (lease: SandboxLease, failure: { bootFailed: boolean; retrying: boolean }) => report({ ...base(lease), kind: "failed", ...failure }),
  }
}
