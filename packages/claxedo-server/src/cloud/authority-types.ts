/**
 * Durable Workspace Authority — type definitions.
 *
 * One authority object per workspace owns live truth:
 * lease state, epoch, sandbox identity, heartbeat, retry, holds,
 * and reconnect validation.
 *
 * These types are consumed by:
 * - the lease/hold persistence layer (SQLite)
 * - the lifecycle decision engine
 * - the workspace-supervisor reconciler
 * - the Convex mirror adapter
 */

import type { SandboxProviderID } from "./types"

// ── Workspace lease status ─────────────────────────────────────────────

export type LeaseStatus =
  | "pending"       // workspace created, no sandbox yet
  | "acquiring"     // acquiring sandbox from provider
  | "starting"      // sandbox acquired, runtime deploying
  | "ready"         // runtime healthy and serving
  | "unhealthy"     // health checks failing, may recover
  | "backoff"       // crashed, waiting before retry
  | "stopping"      // graceful stop in progress
  | "stopped"       // idle-stopped, sandbox may still exist
  | "failed"        // terminal failure after max retries

// ── Compute class ──────────────────────────────────────────────────────

export type ComputeClass = "small" | "medium" | "large" | "gpu"

// ── Per-workspace durable lease state ──────────────────────────────────

export type WorkspaceLease = {
  workspace_id: string
  lease_id: string
  epoch: number
  status: LeaseStatus
  provider: SandboxProviderID
  provider_object_id: string | null
  provider_snapshot_id: string | null
  sandbox_id: string | null
  runtime_url: string | null
  retry_count: number
  next_retry_at: number | null
  last_heartbeat_at: number | null
  last_activity_at: number | null
  last_health_failure_at: number | null
  last_error: string | null
  compute_class: ComputeClass | null
  accel_base_image_id: string | null
  accel_prepared_image_id: string | null
  accel_runtime_snapshot_id: string | null
  created_at: number
  updated_at: number
}

// ── Explicit hold rows ─────────────────────────────────────────────────

export type HoldOwnerType = "session" | "stream" | "pty" | "process" | "system"

export type WorkspaceHold = {
  hold_id: string
  workspace_id: string
  owner_type: HoldOwnerType
  owner_id: string
  reason: string
  expires_at: number | null
  updated_at: number
}

// ── Epoch-fenced message envelope ──────────────────────────────────────

export type EpochEnvelope = {
  workspace_id: string
  lease_id: string
  epoch: number
  sandbox_id: string
}

// ── Authority mutation results ─────────────────────────────────────────

export type AcquireResult = {
  lease: WorkspaceLease
  bumped_epoch: boolean
}

export type HeartbeatResult =
  | { accepted: true }
  | { accepted: false; reason: "stale_epoch" | "unknown_workspace" | "wrong_lease" }

export type ReconnectResult =
  | { accepted: true; lease: WorkspaceLease }
  | { accepted: false; reason: "stale_epoch" | "unknown_workspace" | "wrong_lease" | "wrong_sandbox" }

// ── Provider capability flags ──────────────────────────────────────────

export type ProviderCapabilities = {
  supports_persistent_resume: boolean
  supports_filesystem_snapshot: boolean
  supports_prepared_images: boolean
  supports_explicit_stop: boolean
  supports_health_probe: boolean
}

// ── Authority event (for Convex mirror) ────────────────────────────────

export type AuthorityEvent =
  | { type: "lease_acquired"; lease: WorkspaceLease }
  | { type: "lease_updated"; lease: WorkspaceLease; changed: (keyof WorkspaceLease)[] }
  | { type: "lease_released"; workspace_id: string; reason: string }
  | { type: "hold_acquired"; hold: WorkspaceHold }
  | { type: "hold_released"; hold_id: string; workspace_id: string }
  | { type: "epoch_bumped"; workspace_id: string; old_epoch: number; new_epoch: number }
  | { type: "heartbeat_rejected"; workspace_id: string; envelope: EpochEnvelope; reason: string }
