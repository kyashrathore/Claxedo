import type { SandboxLease } from "./contract"

/**
 * A driver's ensure throws this shape when the runtime process exited before it
 * was ever ready. The cause is in the boot itself (a repository credential that
 * is gone, a branch that does not exist), so polling the driver again cannot
 * heal it. Structural for the reason `SandboxListingUnsupported` is.
 */
export type SandboxRuntimeBootFailure = { runtimeBootFailed: true; message: string }

export function isSandboxRuntimeBootFailure(err: unknown): err is SandboxRuntimeBootFailure {
  return !!err && typeof err === "object" && (err as { runtimeBootFailed?: unknown }).runtimeBootFailed === true
}

export class SandboxRuntimeBootError extends Error implements SandboxRuntimeBootFailure {
  readonly runtimeBootFailed = true as const
  constructor(reason: string) {
    super(reason)
    this.name = "SandboxRuntimeBootError"
  }
}

/** Leads the error an ensure reports, and a lease keeps, for a runtime whose boot failed. */
const RUNTIME_BOOT_FAILED = "runtime_boot_failed: "

export function sandboxRuntimeBootFailedError(reason: string) {
  return `${RUNTIME_BOOT_FAILED}${reason}`
}

/** The boot's own reason when an ensure error says a runtime's boot failed. */
export function sandboxRuntimeBootFailure(error: string | undefined) {
  return error?.startsWith(RUNTIME_BOOT_FAILED) ? error.slice(RUNTIME_BOOT_FAILED.length) : undefined
}

/** The error a lease keeps when the runtime it serves stopped answering its health reports. */
export const SANDBOX_RUNTIME_UNHEALTHY = "runtime_unhealthy"

export function sandboxLeaseFailure(
  lease: SandboxLease,
  input: { now: number; maxRetryCount: number },
): SandboxLeaseFailure | undefined {
  if (lease.status !== "unavailable" || !lease.lastError) return undefined
  const boot = sandboxRuntimeBootFailure(lease.lastError)
  const kind = boot !== undefined ? "boot" : lease.lastError === SANDBOX_RUNTIME_UNHEALTHY ? "unhealthy" : "provider"
  const retrying = kind !== "boot" && lease.retryCount < input.maxRetryCount
    && lease.nextRetryAt !== undefined && lease.nextRetryAt > input.now
  return { kind, message: boot ?? lease.lastError, retrying }
}

/**
 * `boot` carries the runtime's own reason, which repeats until what it boots
 * from changes; `unhealthy` is a serving runtime that stopped answering; and
 * `provider` the driver's error. `retrying` holds while the lease's scheduled
 * retry is still ahead and its retry budget is not spent: a start in progress
 * is waiting it out, and the next ensure runs it.
 */
export type SandboxLeaseFailure = { kind: "boot" | "unhealthy" | "provider"; message: string; retrying: boolean }
