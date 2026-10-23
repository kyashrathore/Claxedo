import type { MachineBlockedReason } from "@claxedo/account-contract/machine"

/** `online` while the machine's enrollment lease is live, `offline` once it lapsed, `paused` while its owner paused serving. */
export type HostDeviceState = "online" | "offline" | "paused"

/** A workspace assigned to the machine, by the name and folder the owner knows it by. */
export type HostDeviceAssignment = { workspace_id: string; display_name: string; directory: string }

/** One root of the owner's scope, with the assignments that removing it alone would retire. */
export type HostDeviceRoot = { path: string; retires: HostDeviceAssignment[] }

/** What the machine last reported stopping it from serving, until it next acquires a serving generation. */
export type HostDeviceBlocked = { reason: MachineBlockedReason; fix: string; reported_at: number }

export type HostDevice = {
  host_id: string
  enrollment_id: string
  display_name: string
  last_seen_at: number
  expires_at: number
  state: HostDeviceState
  workspace_ids: string[]
  acked_workspace_ids: string[]
  cli_version?: string
  os?: string
  arch?: string
  /** Absent for a machine with no owner scope, such as one enrolled from its owner's desktop. */
  roots?: HostDeviceRoot[]
  blocked?: HostDeviceBlocked
}

/**
 * What `claxedo connect` reports about itself. `generation` is the serving
 * generation the reporting process holds, absent when it never acquired one;
 * a report from an instance a newer one has superseded is not recorded.
 */
export type HostMachineReport = {
  cliVersion: string
  os?: string
  arch?: string
  generation?: number
  blocked?: { reason: MachineBlockedReason; fix: string }
}
