import type { SandboxLeaseRow } from "./lease-types"
import { sandboxDriverCatalog } from "./driver-catalog"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"

export type SandboxDecision =
  | { action: "skip"; reason: string }
  | { action: "wait"; until: number; reason: string }
  | { action: "resume"; reason: string }
  | { action: "restore_snapshot"; snapshot_id: string; reason: string }
  | { action: "start_prepared"; image_id: string; reason: string }
  | { action: "start_fresh"; reason: string }
  | { action: "stop_idle"; reason: string }
  | { action: "mark_failed"; reason: string }

export type SandboxDecisionConfig = {
  maxRetries: number
  idleMs: number
  backoffMaxMs: number
  healthTimeoutMs: number
}

export type SandboxDriverPlacement = {
  canPauseAndRestartSameResource: boolean
  canCreateFilesystemSnapshot: boolean
  canStartFromPreparedImage: boolean
  canStopExplicitly: boolean
  hasHealthProbe: boolean
}

export const DEFAULT_WORKSPACE_HOST_DECISION_CONFIG: SandboxDecisionConfig = {
  maxRetries: 8,
  idleMs: 10 * 60 * 1000,
  backoffMaxMs: 30_000,
  healthTimeoutMs: 60_000,
}

export function sandboxDriverPlacement(driver: SandboxDriverID): SandboxDriverPlacement {
  const metadata = sandboxDriverCatalog[driver].metadata
  return {
    canPauseAndRestartSameResource: metadata.persistence.resume === "same-sandbox",
    canCreateFilesystemSnapshot: metadata.persistence.capture === "filesystem"
      || metadata.persistence.capture === "directories",
    canStartFromPreparedImage: driver === "exe"
      || driver === "daytona"
      || driver === "modal"
      || driver === "box"
      || driver === "docker",
    canStopExplicitly: metadata.hostStopBehavior !== "not-supported",
    hasHealthProbe: true,
  }
}

export function decideSandboxStart(
  lease: SandboxLeaseRow,
  placement: SandboxDriverPlacement,
  now: number,
  config: SandboxDecisionConfig = DEFAULT_WORKSPACE_HOST_DECISION_CONFIG,
): SandboxDecision {
  if (lease.status === "ready") {
    return { action: "skip", reason: "already ready" }
  }
  if (lease.status === "failed") {
    return { action: "mark_failed", reason: `terminal failure: ${lease.last_error ?? "unknown"}` }
  }
  if (lease.status === "backoff") {
    if (lease.retry_count >= config.maxRetries) {
      return { action: "mark_failed", reason: `exceeded max retries (${config.maxRetries})` }
    }
    if (lease.next_retry_at && now < lease.next_retry_at) {
      return { action: "wait", until: lease.next_retry_at, reason: "backoff timer not elapsed" }
    }
  }
  if (lease.status === "acquiring" || lease.status === "starting") {
    return { action: "skip", reason: `already ${lease.status}` }
  }
  return decideStartMethod(lease, placement)
}

export function decideSandboxHealthFailure(
  lease: SandboxLeaseRow,
  _placement: SandboxDriverPlacement,
  now: number,
  config: SandboxDecisionConfig = DEFAULT_WORKSPACE_HOST_DECISION_CONFIG,
): SandboxDecision {
  if (lease.status !== "ready" && lease.status !== "unhealthy") {
    return { action: "skip", reason: `status is ${lease.status}, health check not applicable` }
  }
  const retryCount = lease.retry_count + 1
  if (retryCount > config.maxRetries) {
    return { action: "mark_failed", reason: `health failures exceeded max retries (${config.maxRetries})` }
  }
  const backoff = Math.min(config.backoffMaxMs, 1_000 * 2 ** Math.max(0, retryCount - 1))
  return { action: "wait", until: now + backoff, reason: `health failure #${retryCount}, backoff ${backoff}ms` }
}

// `decideSandboxIdle` was DELETED here (W1.4, 2026-07-30). It had zero
// production callers — only its own unit test — while every sibling in this
// file is wired (`decideSandboxStart` and `decideSandboxHealthFailure` from
// workspace-supervisor-sandbox.ts, `nextSandboxRetryAt` from the sqlite
// supervisor store). Idle shutdown is covered twice over without it: the
// provider expires the sandbox itself (Daytona auto-stops at 15 min by default
// and now gets explicit autoStop/autoDelete from hosted-services.ts), and
// `garbageCollect()` reaps anything whose lease no longer matches — which is
// the layer W1 just made able to see. A third dormant safety layer that has
// never run is not defense in depth; it is code that would be trusted the first
// time it fired, having never been exercised. If idle stop is wanted as a
// control-plane decision later, wire it on the way in.
//
// `stop_idle` remains in `SandboxDecision` because it is the union's vocabulary,
// not a live branch.

export function nextSandboxRetryAt(
  retryCount: number,
  now: number,
  config: SandboxDecisionConfig = DEFAULT_WORKSPACE_HOST_DECISION_CONFIG,
) {
  if (retryCount >= config.maxRetries) return null
  return now + Math.min(config.backoffMaxMs, 1_000 * 2 ** Math.max(0, retryCount))
}

function decideStartMethod(
  lease: SandboxLeaseRow,
  placement: SandboxDriverPlacement,
): SandboxDecision {
  if (lease.sandbox_id && placement.canPauseAndRestartSameResource) {
    return { action: "resume", reason: `resume sandbox ${lease.sandbox_id}` }
  }
  if (lease.accel_snapshot_id && placement.canCreateFilesystemSnapshot) {
    return {
      action: "restore_snapshot",
      snapshot_id: lease.accel_snapshot_id,
      reason: `restore snapshot ${lease.accel_snapshot_id}`,
    }
  }
  if (lease.accel_prepared_image_id && placement.canStartFromPreparedImage) {
    return {
      action: "start_prepared",
      image_id: lease.accel_prepared_image_id,
      reason: `start from prepared image ${lease.accel_prepared_image_id}`,
    }
  }
  return { action: "start_fresh", reason: "no acceleration available, cold start" }
}
