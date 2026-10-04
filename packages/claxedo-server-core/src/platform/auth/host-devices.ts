export type HostAssignmentDevice = {
  host_id: string
  enrollment_id: string
  display_name: string
  last_seen_at: number
  expires_at: number
  workspace_ids: string[]
  acked_workspace_ids: string[]
}
