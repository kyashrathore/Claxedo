import { isSandboxDriverID, sandboxDriverLabels } from "@claxedo/sandbox-contract"
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

/**
 * A driver throws this shape when its provider refused the key the driver was
 * made with (an HTTP 401 or 403 to the key itself). Retrying cannot heal it;
 * a new key can, which is why the person is told where keys are kept.
 */
export type SandboxProviderKeyRefused = { providerKeyRefused: true; message: string }

export function isSandboxProviderKeyRefused(err: unknown): err is SandboxProviderKeyRefused {
  return !!err && typeof err === "object" && (err as { providerKeyRefused?: unknown }).providerKeyRefused === true
}

export class SandboxProviderKeyRefusedError extends Error implements SandboxProviderKeyRefused {
  readonly providerKeyRefused = true as const
  constructor(reason: string) {
    super(reason)
    this.name = "SandboxProviderKeyRefusedError"
  }
}

/** The error a lease keeps when `driver`'s provider refused its key. */
export function sandboxProviderKeyRefusedError(driver: string, reason: string) {
  const provider = isSandboxDriverID(driver) ? sandboxDriverLabels[driver] : driver
  return `${provider} refused the sandbox provider key: ${reason}. Fix the key in Settings → Sandbox providers.`
}

export const SANDBOX_START_WINDOWS = ["minute", "hour", "day"] as const

export type SandboxStartWindow = (typeof SANDBOX_START_WINDOWS)[number]

/** A provider's start limit an account used up: `limit` starts per `window`, a resume among them when `resumeCounts`. */
export type SandboxStartLimit = { window: SandboxStartWindow; limit: number; resumeCounts: boolean }

/**
 * A driver throws this shape when its provider refused a start because the
 * account's start limit is used up. A minute's or an hour's limit is waited
 * out before the next attempt; a day's is not retried on its own, since every
 * attempt until it frees up is refused again, and a person trying again runs it.
 */
export type SandboxProviderRateLimited = { providerRateLimited: SandboxStartLimit; message: string }

export function isSandboxProviderRateLimited(err: unknown): err is SandboxProviderRateLimited {
  const limit = !!err && typeof err === "object" ? (err as { providerRateLimited?: unknown }).providerRateLimited : undefined
  return !!limit && typeof limit === "object" && SANDBOX_START_WINDOWS.some((window) => window === (limit as { window?: unknown }).window)
}

export class SandboxProviderRateLimitedError extends Error implements SandboxProviderRateLimited {
  constructor(readonly providerRateLimited: SandboxStartLimit, reason: string) {
    super(reason)
    this.name = "SandboxProviderRateLimitedError"
  }
}

/** How long a start waits out a used-up limit before it is tried again; a day's limit has no automatic retry. */
export function sandboxStartLimitRetryMs(window: SandboxStartWindow): number | undefined {
  return window === "minute" ? 60_000 : window === "hour" ? 3_600_000 : undefined
}

/** Leads the error a lease keeps for a start refused at the provider's start limit, with the window that is used up. */
const PROVIDER_RATE_LIMITED = "provider_rate_limited:"

/**
 * The error a lease keeps when `driver`'s provider refused a start at its
 * start limit. The provider names no time the window frees up, so the person
 * is told the window, and the time Claxedo tries again only for the windows it
 * waits out.
 */
export function sandboxProviderRateLimitedError(driver: string, limit: SandboxStartLimit) {
  const provider = isSandboxDriverID(driver) ? sandboxDriverLabels[driver] : driver
  const again = limit.window === "day"
    ? "Sandboxes can start again once that daily limit frees a start: try again then."
    : `Claxedo tries again in ${limit.window === "minute" ? "a minute" : "an hour"}.`
  return `${PROVIDER_RATE_LIMITED}${limit.window}: ${provider}'s start limit for this account is used up (${limit.limit} starts per ${limit.window}). ${again}${limit.resumeCounts ? " A wake counts as a start too." : ""}`
}

/** The used-up window when a lease's error is a start the provider refused at its start limit. */
export function sandboxProviderRateLimit(error: string | undefined): SandboxStartWindow | undefined {
  if (!error?.startsWith(PROVIDER_RATE_LIMITED)) return undefined
  const window = error.slice(PROVIDER_RATE_LIMITED.length).split(":", 1)[0]
  return SANDBOX_START_WINDOWS.find((name) => name === window)
}

function providerRateLimitedReason(error: string) {
  return sandboxProviderRateLimit(error) === undefined ? undefined : error.slice(error.indexOf(": ") + 2)
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

/** The line a person is told for a start step's error: the runtime's own reason for a boot that failed, else the driver's first line. */
export function sandboxStartFailureReason(error: string): string {
  return sandboxRuntimeBootFailure(error) ?? providerRateLimitedReason(error) ?? error.split("\n", 1)[0]?.trim() ?? error
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
  return { kind, message: sandboxStartFailureReason(lease.lastError), retrying }
}

/**
 * `boot` carries the runtime's own reason, which repeats until what it boots
 * from changes; `unhealthy` is a serving runtime that stopped answering; and
 * `provider` the driver's error. `retrying` holds while the lease's scheduled
 * retry is still ahead and its retry budget is not spent: a start in progress
 * is waiting it out, and the next ensure runs it.
 */
export type SandboxLeaseFailure = { kind: "boot" | "unhealthy" | "provider"; message: string; retrying: boolean }
