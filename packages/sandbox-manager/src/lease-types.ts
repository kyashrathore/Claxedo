import type { SandboxDriverID } from "./driver-catalog"

export type SandboxLeaseRowStatus =
  | "pending"
  | "acquiring"
  | "starting"
  | "ready"
  | "unhealthy"
  | "backoff"
  | "stopping"
  | "stopped"
  | "failed"

export type SandboxComputeClass = "small" | "medium" | "large" | "gpu"

export type SandboxLeaseRow = {
  workspace_id: string
  lease_id: string
  home_region?: string
  epoch: number
  status: SandboxLeaseRowStatus
  driver: SandboxDriverID
  driver_resource_id: string | null
  driver_snapshot_id: string | null
  sandbox_id: string | null
  url: string | null
  retry_count: number
  next_retry_at: number | null
  last_heartbeat_at: number | null
  last_activity_at: number | null
  last_health_failure_at: number | null
  last_error: string | null
  compute_class: SandboxComputeClass | null
  accel_base_image_id: string | null
  accel_prepared_image_id: string | null
  accel_snapshot_id: string | null
  created_at: number
  updated_at: number
}

export type SandboxHoldRowOwnerType = "session" | "stream" | "pty" | "process" | "system"

export type SandboxHoldRow = {
  hold_id: string
  workspace_id: string
  owner_type: SandboxHoldRowOwnerType
  owner_id: string
  reason: string
  expires_at: number | null
  updated_at: number
}

export type SandboxEpochEnvelope = {
  workspace_id: string
  lease_id: string
  epoch: number
  sandbox_id: string
}

export type SandboxRowAcquireResult = {
  lease: SandboxLeaseRow
  bumped_epoch: boolean
}

export type SandboxRowHeartbeatResult =
  | { accepted: true }
  | { accepted: false; reason: "stale_epoch" | "unknown_workspace" | "wrong_lease" }

export type SandboxRowReconnectResult =
  | { accepted: true; lease: SandboxLeaseRow }
  | { accepted: false; reason: "stale_epoch" | "unknown_workspace" | "wrong_lease" | "wrong_sandbox" }

export type SandboxRowEvent =
  | { type: "lease_acquired"; lease: SandboxLeaseRow }
  | { type: "lease_updated"; lease: SandboxLeaseRow; changed: (keyof SandboxLeaseRow)[] }
  | { type: "lease_released"; workspace_id: string; reason: string }
  | { type: "hold_acquired"; hold: SandboxHoldRow }
  | { type: "hold_released"; hold_id: string; workspace_id: string }
  | { type: "epoch_bumped"; workspace_id: string; old_epoch: number; new_epoch: number }
  | { type: "heartbeat_rejected"; workspace_id: string; envelope: SandboxEpochEnvelope; reason: string }
