import type { SandboxLeaseRow } from "./lease-types"
import { sandboxDriverCatalog, type SandboxDriverID } from "./driver-catalog"

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

export function decideSandboxIdle(
  lease: SandboxLeaseRow,
  activeHoldCount: number,
  now: number,
  config: SandboxDecisionConfig = DEFAULT_WORKSPACE_HOST_DECISION_CONFIG,
): SandboxDecision {
  if (lease.status !== "ready") {
    return { action: "skip", reason: `status is ${lease.status}, not ready` }
  }
  if (activeHoldCount > 0) {
    return { action: "skip", reason: `${activeHoldCount} active hold(s)` }
  }
  const lastActivity = lease.last_activity_at ?? lease.created_at
  const idleFor = now - lastActivity
  if (idleFor < config.idleMs) {
    return { action: "wait", until: lastActivity + config.idleMs, reason: `idle for ${idleFor}ms, need ${config.idleMs}ms` }
  }
  return { action: "stop_idle", reason: `idle for ${idleFor}ms (threshold: ${config.idleMs}ms)` }
}

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
