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

/**
 * A driver throws this shape when the provider says the host a lease names no
 * longer exists: deleted outside the control plane, or its stopped disk
 * expired. Nothing on that host can serve or be stopped again, so the lease
 * ends and the next start places a new host.
 */
export type SandboxHostGone = { hostGone: true; message: string }

export function isSandboxHostGone(err: unknown): err is SandboxHostGone {
  return !!err && typeof err === "object" && (err as { hostGone?: unknown }).hostGone === true
}

export class SandboxHostGoneError extends Error implements SandboxHostGone {
  readonly hostGone = true as const
  constructor(reason: string) {
    super(reason)
    this.name = "SandboxHostGoneError"
  }
}

/** Leads the error an ensure reports, and a lease keeps, for a runtime whose boot failed. */
const RUNTIME_BOOT_FAILED = "runtime_boot_failed: "

/** Leads the error a destroyed lease keeps when its host was found gone at the provider. */
const RUNTIME_HOST_GONE = "runtime_host_gone: "

export function sandboxRuntimeBootFailedError(reason: string) {
  return `${RUNTIME_BOOT_FAILED}${reason}`
}

export function sandboxHostGoneError(reason: string) {
  return `${RUNTIME_HOST_GONE}${reason}`
}

/**
 * The stderr line a workspace runtime prints before it exits on a boot it
 * cannot finish (`hosts/workspace-runtime/boot-contract.ts` in the server
 * spells the same word). Drivers hand the manager their own diagnostic with
 * the runtime's log tail inside it; the reason a person is told is this
 * line's, with the stack trace that follows it dropped.
 */
const WORKSPACE_RUNTIME_BOOT_FAILED_LINE = "workspace_runtime_boot_failed: "

export function workspaceRuntimeBootReason(diagnostic: string): string | undefined {
  const at = diagnostic.lastIndexOf(WORKSPACE_RUNTIME_BOOT_FAILED_LINE)
  if (at < 0) return undefined
  const [reason = ""] = diagnostic.slice(at + WORKSPACE_RUNTIME_BOOT_FAILED_LINE.length).split(/\n\s+at /)
  return reason.trim().replace(/^Error: /, "") || undefined
}

/**
 * What a driver keeps of a runtime's log within `maxChars`. A Node stack
 * under the boot-failure line is longer than the bound a driver puts on the
 * tail (600 chars on Boat, 2026-10-15 staging), so a tail alone keeps the
 * frames and loses the one line that names the reason.
 */
export function runtimeBootDiagnostic(log: string, maxChars: number): string {
  const trimmed = log.trim()
  const reason = workspaceRuntimeBootReason(trimmed)
  if (reason === undefined) return trimmed.slice(-maxChars)
  return `${WORKSPACE_RUNTIME_BOOT_FAILED_LINE}${reason}`.slice(0, maxChars)
}

/** The boot's own reason when an ensure error says a runtime's boot failed. */
export function sandboxRuntimeBootFailure(error: string | undefined) {
  if (!error?.startsWith(RUNTIME_BOOT_FAILED)) return undefined
  const diagnostic = error.slice(RUNTIME_BOOT_FAILED.length)
  return workspaceRuntimeBootReason(diagnostic) ?? diagnostic
}

/** The error a lease keeps when the runtime it serves stopped answering its health reports. */
export const SANDBOX_RUNTIME_UNHEALTHY = "runtime_unhealthy"

/**
 * The answers a start step gives when the lease moved on under it: stopped or
 * destroyed by a lifecycle call, or replaced by another epoch. None is a
 * failure of the start, so none is reported to the person who began it.
 */
const LEASE_ENDED_ERRORS: ReadonlySet<string> = new Set(["runtime_lease_changed", "runtime_lease_stopped", "runtime_lease_destroyed"])

export function sandboxLeaseEndedUnderStart(error: string | undefined) {
  return error !== undefined && LEASE_ENDED_ERRORS.has(error)
}

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
