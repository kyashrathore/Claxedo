/**
 * Lifecycle Decision Engine — pure logic, no side effects.
 *
 * Input:  persisted lease state + provider capabilities + time
 * Output: the next action the supervisor should take
 *
 * This module never calls a provider, never writes to storage,
 * never broadcasts. The supervisor (effect layer) executes the
 * returned decision.
 */

import type { WorkspaceLease, ProviderCapabilities } from "../authority-types"

// ── Decision outcomes ──────────────────────────────────────────────────

export type Decision =
  | { action: "skip"; reason: string }
  | { action: "wait"; until: number; reason: string }
  | { action: "resume"; reason: string }
  | { action: "restore_snapshot"; snapshot_id: string; reason: string }
  | { action: "start_prepared"; image_id: string; reason: string }
  | { action: "start_fresh"; reason: string }
  | { action: "stop_idle"; reason: string }
  | { action: "mark_failed"; reason: string }

// ── Configuration ──────────────────────────────────────────────────────

export type DecisionConfig = {
  max_retries: number
  idle_ms: number
  backoff_max_ms: number
  health_timeout_ms: number
}

export const DEFAULT_CONFIG: DecisionConfig = {
  max_retries: 8,
  idle_ms: 10 * 60 * 1000,
  backoff_max_ms: 30_000,
  health_timeout_ms: 60_000,
}

// ── Start decision ─────────────────────────────────────────────────────

/**
 * Decide what to do when a workspace needs to be started or restarted.
 *
 * Called when ensureWorkspaceRuntime is invoked and the workspace is
 * not currently in "ready" status.
 */
export function decideStart(
  lease: WorkspaceLease,
  caps: ProviderCapabilities,
  now: number,
  config: DecisionConfig = DEFAULT_CONFIG,
): Decision {
  // Already running — nothing to do
  if (lease.status === "ready") {
    return { action: "skip", reason: "already ready" }
  }

  // Terminal failure — don't retry
  if (lease.status === "failed") {
    return { action: "mark_failed", reason: `terminal failure: ${lease.last_error ?? "unknown"}` }
  }

  // In backoff — check if we can retry yet
  if (lease.status === "backoff") {
    if (lease.retry_count >= config.max_retries) {
      return { action: "mark_failed", reason: `exceeded max retries (${config.max_retries})` }
    }
    if (lease.next_retry_at && now < lease.next_retry_at) {
      return { action: "wait", until: lease.next_retry_at, reason: "backoff timer not elapsed" }
    }
    // Fall through to start logic below
  }

  // Currently starting — skip to avoid double-start
  if (lease.status === "acquiring" || lease.status === "starting") {
    return { action: "skip", reason: `already ${lease.status}` }
  }

  // Stopped or pending — decide how to start
  return decideStartMethod(lease, caps)
}

/**
 * Decide the best start method based on acceleration layers and provider caps.
 *
 * Precedence:
 * 1. Resume existing sandbox (if provider supports + sandbox still known)
 * 2. Restore from runtime snapshot
 * 3. Start from prepared image
 * 4. Cold start from base image
 */
function decideStartMethod(
  lease: WorkspaceLease,
  caps: ProviderCapabilities,
): Decision {
  // Try resume if sandbox still exists and provider supports it
  if (lease.sandbox_id && caps.supports_persistent_resume) {
    return { action: "resume", reason: `resume sandbox ${lease.sandbox_id}` }
  }

  // Try runtime snapshot
  if (lease.accel_runtime_snapshot_id && caps.supports_filesystem_snapshot) {
    return {
      action: "restore_snapshot",
      snapshot_id: lease.accel_runtime_snapshot_id,
      reason: `restore snapshot ${lease.accel_runtime_snapshot_id}`,
    }
  }

  // Try prepared image
  if (lease.accel_prepared_image_id && caps.supports_prepared_images) {
    return {
      action: "start_prepared",
      image_id: lease.accel_prepared_image_id,
      reason: `start from prepared image ${lease.accel_prepared_image_id}`,
    }
  }

  // Fall back to cold start
  return { action: "start_fresh", reason: "no acceleration available, cold start" }
}

// ── Idle decision ──────────────────────────────────────────────────────

/**
 * Decide whether a running workspace should be stopped due to idleness.
 */
export function decideIdle(
  lease: WorkspaceLease,
  activeHoldCount: number,
  now: number,
  config: DecisionConfig = DEFAULT_CONFIG,
): Decision {
  if (lease.status !== "ready") {
    return { action: "skip", reason: `status is ${lease.status}, not ready` }
  }

  if (activeHoldCount > 0) {
    return { action: "skip", reason: `${activeHoldCount} active hold(s)` }
  }

  const lastActivity = lease.last_activity_at ?? lease.created_at
  const idleFor = now - lastActivity

  if (idleFor < config.idle_ms) {
    return { action: "wait", until: lastActivity + config.idle_ms, reason: `idle for ${idleFor}ms, need ${config.idle_ms}ms` }
  }

  return { action: "stop_idle", reason: `idle for ${idleFor}ms (threshold: ${config.idle_ms}ms)` }
}

// ── Health decision ────────────────────────────────────────────────────

/**
 * Decide what to do when a health check fails.
 */
export function decideHealthFailure(
  lease: WorkspaceLease,
  caps: ProviderCapabilities,
  now: number,
  config: DecisionConfig = DEFAULT_CONFIG,
): Decision {
  if (lease.status !== "ready" && lease.status !== "unhealthy") {
    return { action: "skip", reason: `status is ${lease.status}, health check not applicable` }
  }

  const newRetryCount = lease.retry_count + 1

  if (newRetryCount > config.max_retries) {
    return { action: "mark_failed", reason: `health failures exceeded max retries (${config.max_retries})` }
  }

  const backoff = Math.min(config.backoff_max_ms, 1_000 * 2 ** Math.max(0, newRetryCount - 1))
  const retryAt = now + backoff

  // After health failure, the supervisor will record the failure and
  // then re-evaluate start decision on the next reconcile pass
  return { action: "wait", until: retryAt, reason: `health failure #${newRetryCount}, backoff ${backoff}ms` }
}

// ── Backoff calculation ────────────────────────────────────────────────

/**
 * Calculate the next retry timestamp given current retry count.
 * Returns null if max retries exceeded (terminal failure).
 */
export function nextRetryAt(
  retryCount: number,
  now: number,
  config: DecisionConfig = DEFAULT_CONFIG,
): number | null {
  if (retryCount >= config.max_retries) return null
  const backoff = Math.min(config.backoff_max_ms, 1_000 * 2 ** Math.max(0, retryCount))
  return now + backoff
}
