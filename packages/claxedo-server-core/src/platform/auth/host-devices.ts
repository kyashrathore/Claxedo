/** `online` while the machine's enrollment lease is live, `offline` once it lapsed, `paused` while its owner paused serving. */
export type HostDeviceState = "online" | "offline" | "paused"

export type HostDevice = {
  host_id: string
  enrollment_id: string
  display_name: string
  last_seen_at: number
  expires_at: number
  state: HostDeviceState
  workspace_ids: string[]
  acked_workspace_ids: string[]
}
