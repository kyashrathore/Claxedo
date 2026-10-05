import type { SandboxLease } from "./contract"

/**
 * The lease transitions a deployment meters. A lease epoch is one boot: a wake
 * acquires a new epoch with its own start, so `activeMs` (the epoch's start to
 * its stop or destroy) is the machine time that boot spent, and is present only
 * when the lease was serving at that moment.
 */
export type SandboxLifecycleEvent = {
  workspaceId: string
  epoch: number
  driver: string
  labels: Record<string, string>
} & (
  | { kind: "stopped"; idle: boolean; activeMs?: number }
  | { kind: "destroyed"; activeMs?: number }
  | { kind: "failed"; bootFailed: boolean }
)

export function createLifecycleReporter(sink: ((event: SandboxLifecycleEvent) => void) | undefined, now: () => number) {
  const base = (lease: SandboxLease) => ({ workspaceId: lease.workspaceId, epoch: lease.epoch, driver: lease.driver, labels: lease.labels ?? {} })
  const active = (lease: SandboxLease) =>
    lease.status === "ready" && lease.start ? { activeMs: Math.max(0, now() - lease.start.startedAt) } : {}
  const report = (event: SandboxLifecycleEvent) => {
    try {
      sink?.(event)
    } catch {
      // A lifecycle sink observes the transition; it is never part of it.
    }
  }
  return {
    stopped: (lease: SandboxLease, idle: boolean) => report({ ...base(lease), kind: "stopped", idle, ...active(lease) }),
    destroyed: (lease: SandboxLease) => report({ ...base(lease), kind: "destroyed", ...active(lease) }),
    failed: (lease: SandboxLease, bootFailed: boolean) => report({ ...base(lease), kind: "failed", bootFailed }),
  }
}
