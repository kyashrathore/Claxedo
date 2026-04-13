/**
 * Lifecycle Effect Runner — executes decisions from the decision engine.
 *
 * This module takes a Decision and:
 * - calls the provider adapter (sandbox-pool, sandbox-runtime)
 * - updates the durable authority (workspace lease)
 * - broadcasts state changes
 *
 * It does NOT contain decision logic — that's in decision.ts.
 */

import type { WorkspaceLease } from "../authority-types"
import type { Decision } from "./decision"
import { nextRetryAt } from "./decision"
import * as authority from "../authority"
import { Log } from "../../log"

const log = Log.create({ service: "lifecycle-effect" })

export type EffectContext = {
  workspaceId: string
  lease: WorkspaceLease
}

export type EffectResult =
  | { ok: true; lease: WorkspaceLease }
  | { ok: false; error: string }

/**
 * Execute a lifecycle decision against the authority and provider layer.
 *
 * Provider calls (acquire sandbox, deploy runtime, etc.) are left to
 * the workspace-supervisor since they need access to SandboxHandle
 * instances and event streaming. This effect runner handles the
 * authority-side state transitions that wrap those calls.
 */
export function applyDecision(ctx: EffectContext, decision: Decision): EffectResult {
  const { workspaceId } = ctx

  switch (decision.action) {
    case "skip":
      log.debug("Lifecycle skip", { workspaceId, reason: decision.reason })
      return { ok: true, lease: ctx.lease }

    case "wait":
      log.debug("Lifecycle wait", { workspaceId, until: decision.until, reason: decision.reason })
      return { ok: true, lease: ctx.lease }

    case "resume":
    case "restore_snapshot":
    case "start_prepared":
    case "start_fresh": {
      // Transition to acquiring — the supervisor will perform the actual
      // provider call and then transition to starting → ready
      const lease = authority.transition(workspaceId, "acquiring")
      if (!lease) return { ok: false, error: "workspace not found" }
      log.info("Lifecycle start", { workspaceId, action: decision.action, reason: decision.reason })
      return { ok: true, lease }
    }

    case "stop_idle": {
      const lease = authority.transition(workspaceId, "stopping")
      if (!lease) return { ok: false, error: "workspace not found" }
      log.info("Lifecycle idle stop", { workspaceId, reason: decision.reason })
      return { ok: true, lease }
    }

    case "mark_failed": {
      const lease = authority.transition(workspaceId, "failed", {
        last_error: decision.reason,
        next_retry_at: null,
      })
      if (!lease) return { ok: false, error: "workspace not found" }
      log.warn("Lifecycle terminal failure", { workspaceId, reason: decision.reason })
      return { ok: true, lease }
    }
  }
}

/**
 * Record a start failure on the authority and compute next retry.
 */
export function recordStartFailure(workspaceId: string, error: string): EffectResult {
  const lease = authority.getLease(workspaceId)
  if (!lease) return { ok: false, error: "workspace not found" }

  const now = Date.now()
  const retry = nextRetryAt(lease.retry_count + 1, now)
  const updated = authority.recordFailure(workspaceId, error, retry)
  if (!updated) return { ok: false, error: "workspace not found" }

  log.warn("Start failure recorded", {
    workspaceId,
    retryCount: updated.retry_count,
    nextRetryAt: retry,
    error,
  })
  return { ok: true, lease: updated }
}

/**
 * Record successful sandbox assignment.
 */
export function recordSandboxAssigned(
  workspaceId: string,
  sandboxId: string,
  runtimeUrl: string | null,
  providerObjectId: string | null,
): EffectResult {
  const lease = authority.assignSandbox(workspaceId, sandboxId, runtimeUrl, providerObjectId)
  if (!lease) return { ok: false, error: "workspace not found" }
  log.info("Sandbox assigned", { workspaceId, sandboxId })
  return { ok: true, lease }
}

/**
 * Record runtime ready.
 */
export function recordReady(workspaceId: string, runtimeUrl: string): EffectResult {
  const lease = authority.markReady(workspaceId, runtimeUrl)
  if (!lease) return { ok: false, error: "workspace not found" }
  log.info("Runtime ready", { workspaceId, runtimeUrl })
  return { ok: true, lease }
}

/**
 * Record workspace stopped.
 */
export function recordStopped(workspaceId: string): EffectResult {
  const lease = authority.transition(workspaceId, "stopped", {
    runtime_url: null,
  })
  if (!lease) return { ok: false, error: "workspace not found" }
  log.info("Runtime stopped", { workspaceId })
  return { ok: true, lease }
}
