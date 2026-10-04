import type { D1Database } from "@cloudflare/workers-types"
import type { HostAssignmentDevice } from "@claxedo/server-core/platform/auth/host-devices"
import { parseJson } from "@claxedo/server-core/platform/json/index"

type AssignmentRow = Omit<HostAssignmentDevice, "display_name" | "workspace_ids" | "acked_workspace_ids"> & {
  workspace_id: string
  display_name: string | null
  acked_workspace_ids: string
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** A stored JSON array of ids; a column that is not one contributes no ids. */
function storedStringList(raw: string): string[] {
  try {
    return stringList(parseJson(raw))
  } catch {
    return []
  }
}

/** Every live assignment of the owner's machines, one device row per machine. */
export async function listHostAssignmentDevices(database: D1Database, actorId: string, now: number): Promise<HostAssignmentDevice[]> {
  const rows = await database.prepare(`
    select assignment.workspace_id, assignment.host_id, enrollment.enrollment_id,
      enrollment.display_name, enrollment.last_seen_at, enrollment.expires_at,
      coalesce(enrollment.acked_workspace_ids, '[]') as acked_workspace_ids
    from host_workspace_assignments assignment
    inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
      and enrollment.owner_actor_id = assignment.owner_actor_id
    where assignment.owner_actor_id = ?
      and enrollment.revoked_at is null and enrollment.paused_at is null
      and enrollment.expires_at > ?
    order by assignment.host_id, assignment.workspace_id
  `).bind(actorId, now).all<AssignmentRow>()
  const devices = new Map<string, HostAssignmentDevice>()
  for (const row of rows.results ?? []) {
    const device = devices.get(row.host_id) ?? {
      host_id: row.host_id,
      enrollment_id: row.enrollment_id,
      display_name: row.display_name ?? row.host_id,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      workspace_ids: [],
      acked_workspace_ids: storedStringList(row.acked_workspace_ids),
    }
    device.workspace_ids.push(row.workspace_id)
    devices.set(row.host_id, device)
  }
  return [...devices.values()]
}
