import type { SandboxLease } from "./contract"
import type { SandboxCheckpointUnusableCause, SandboxStartWindow } from "./lease-failure"

/** Who stopped the host: a person or the plane's explicit stop, the idle policy, the plane for a runtime that stopped answering, or the provider on its own. */
export type SandboxStopCause = "explicit" | "idle" | "unresponsive" | "provider"

/** `unsaved`: the stop ended the machine without capturing it; `unfrozen`: it captured files whose runtime did not freeze first. */
export type SandboxStopOutcome = { unsaved?: true; unfrozen?: true }

/**
 * The lease transitions a deployment meters. A lease epoch is one boot: a wake
 * acquires a new epoch with its own start, so `activeMs` (the epoch's start to
 * its stop or destroy) is the machine time that boot spent, and is present only
 * when the lease was serving at that moment. A destroyed epoch is `hostGone`
 * when the provider lost its host, rather than Claxedo destroying it. A failed
 * epoch whose start goes
 * on in the next epoch is `retrying`; the start the person waits on has not
 * failed until an epoch fails without one. `startLimit` is the provider's
 * start-limit window an epoch was refused at. `hostLeftRunning` is a failed
 * start whose host the manager could not stop, so it may still bill, and
 * `checkpointUnusable` the cause of one refused because the checkpoint it
 * restores cannot be used. `startedFresh` is the person dropping the lease's
 * checkpoint so the next start boots the image; its `checkpointUnusable` is
 * the cause the lease's last start was refused for, when it was. A stop is
 * `unsaved` when it ended the machine without capturing it, so the lease
 * keeps the checkpoint it had before, and `unfrozen` when it captured the
 * files of a runtime that did not freeze first.
 */
export type SandboxLifecycleEvent = {
  workspaceId: string
  epoch: number
  driver: string
  labels: Record<string, string>
} & (
  | ({ kind: "stopped"; cause: SandboxStopCause; activeMs?: number } & SandboxStopOutcome)
  | { kind: "destroyed"; hostGone: boolean; activeMs?: number }
  | { kind: "failed" } & SandboxStartFailureFacts
  | { kind: "startedFresh"; checkpointUnusable?: SandboxCheckpointUnusableCause }
)

type SandboxStartFailureFacts = { bootFailed: boolean; retrying: boolean; startLimit?: SandboxStartWindow; hostLeftRunning?: true; checkpointUnusable?: SandboxCheckpointUnusableCause }

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
    stopped: (lease: SandboxLease, cause: SandboxStopCause, outcome: SandboxStopOutcome = {}) =>
      report({ ...base(lease), kind: "stopped", cause, ...active(lease), ...outcome }),
    /** `endedAt` is when the host was last proven serving: a stop the provider made on its own is learned after the fact. */
    hostStopped: (lease: SandboxLease, endedAt?: number) => report({ ...base(lease), kind: "stopped", cause: "provider", ...active(lease, endedAt) }),
    destroyed: (lease: SandboxLease) => report({ ...base(lease), kind: "destroyed", hostGone: false, ...active(lease) }),
    /** `endedAt` is when the host was last proven serving: the provider's loss is learned after the fact. */
    hostGone: (lease: SandboxLease, endedAt?: number) => report({ ...base(lease), kind: "destroyed", hostGone: true, ...active(lease, endedAt) }),
    failed: (lease: SandboxLease, failure: SandboxStartFailureFacts) => report({ ...base(lease), kind: "failed", ...failure }),
    startedFresh: (lease: SandboxLease, checkpointUnusable: SandboxCheckpointUnusableCause | undefined) =>
      report({ ...base(lease), kind: "startedFresh", ...(checkpointUnusable ? { checkpointUnusable } : {}) }),
  }
}
