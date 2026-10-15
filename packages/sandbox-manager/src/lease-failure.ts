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

/**
 * A driver throws this shape when Claxedo, not the provider, refuses the
 * start, and `message` is already the one line a person reads: the lease
 * keeps it as it is, where any other driver error is the provider's.
 */
export type SandboxStartRefusal = { startRefused: true; message: string }

export function isSandboxStartRefusal(err: unknown): err is SandboxStartRefusal {
  return !!err && typeof err === "object" && (err as { startRefused?: unknown }).startRefused === true
}

export class SandboxStartRefusedError extends Error implements SandboxStartRefusal {
  readonly startRefused = true as const
  constructor(reason: string) {
    super(reason)
    this.name = "SandboxStartRefusedError"
  }
}

function sandboxDriverLabel(driver: string) {
  return isSandboxDriverID(driver) ? sandboxDriverLabels[driver] : driver
}

/** Leads the error a lease keeps when the provider refused the driver's key, before the driver's own message. */
const PROVIDER_KEY_REFUSED = "provider_key_refused:"

/** Leads the error a lease keeps when the driver failed at its provider for any other reason, before the driver's own message. */
const PROVIDER_FAILED = "provider_failed:"

/** The error a lease keeps when `driver`'s provider refused its key; the driver's message stays for the operator. */
export function sandboxProviderKeyRefusedError(driver: string, message: string) {
  return `${PROVIDER_KEY_REFUSED}${driver}: ${message}`
}

/** The error a lease keeps when `driver` failed at its provider; the driver's message, which names hosts, requests and provider codes, stays for the operator. */
export function sandboxProviderFailedError(driver: string, message: string) {
  return `${PROVIDER_FAILED}${driver}: ${message}`
}

function codedDriver(error: string, prefix: string): string | undefined {
  if (!error.startsWith(prefix)) return undefined
  const rest = error.slice(prefix.length)
  const end = rest.indexOf(": ")
  return end < 0 ? rest : rest.slice(0, end)
}

export const SANDBOX_START_WINDOWS = ["minute", "hour", "day"] as const

export type SandboxStartWindow = (typeof SANDBOX_START_WINDOWS)[number]

/** A provider's start limit an account used up: `limit` starts per `window`. */
export type SandboxStartLimit = { window: SandboxStartWindow; limit: number }

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

const START_LIMIT_NAMES: Readonly<Record<SandboxStartWindow, string>> = { minute: "per-minute", hour: "hourly", day: "daily" }

/**
 * The error a lease keeps when `driver`'s provider refused a start at its
 * start limit. Claxedo waits out a minute's or an hour's limit itself, and
 * each surface tells when that next try runs, so only a day's line names what
 * the person does.
 */
export function sandboxProviderRateLimitedError(driver: string, limit: SandboxStartLimit) {
  const used = `${sandboxDriverLabel(driver)}'s ${START_LIMIT_NAMES[limit.window]} start limit (${limit.limit}) is used up`
  return `${PROVIDER_RATE_LIMITED}${limit.window}: ${limit.window === "day" ? `${used}; try again later.` : `${used}.`}`
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

/** The error a lease keeps when the runtime it serves stopped answering its health reports. */
export const SANDBOX_RUNTIME_UNHEALTHY = "runtime_unhealthy"

/** The error a capped lease answers when it kept none of its own. */
export const SANDBOX_RETRY_CAP_EXCEEDED = "runtime_retry_cap_exceeded"

const CODED_REASONS: ReadonlyMap<string, string> = new Map([
  [SANDBOX_RUNTIME_UNHEALTHY, "The workspace machine stopped answering."],
  [SANDBOX_RETRY_CAP_EXCEEDED, "Several tries in a row failed; try again later."],
])

function firstLine(text: string) {
  return text.split("\n", 1)[0]?.trim() ?? text
}

/**
 * The one line a person is told for a start step's error: the runtime's own
 * reason for a boot that failed, the provider's refusal in Claxedo's words,
 * else the error's first line.
 */
export function sandboxStartFailureReason(error: string): string {
  const boot = sandboxRuntimeBootFailure(error)
  if (boot !== undefined) return firstLine(boot)
  const limited = providerRateLimitedReason(error)
  if (limited !== undefined) return limited
  const keyRefused = codedDriver(error, PROVIDER_KEY_REFUSED)
  if (keyRefused !== undefined) return `${sandboxDriverLabel(keyRefused)} refused the sandbox provider key; fix it in Settings → Sandbox providers.`
  const failed = codedDriver(error, PROVIDER_FAILED)
  if (failed !== undefined) return `${sandboxDriverLabel(failed)} returned an error.`
  return CODED_REASONS.get(error) ?? firstLine(error)
}

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
