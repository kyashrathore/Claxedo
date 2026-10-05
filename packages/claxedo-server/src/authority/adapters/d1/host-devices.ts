import type { D1Database } from "@cloudflare/workers-types"
import type { HostDevice } from "@claxedo/server-core/platform/auth/host-devices"
import { parseJson } from "@claxedo/server-core/platform/json/index"

type DeviceRow = Omit<HostDevice, "display_name" | "state" | "workspace_ids" | "acked_workspace_ids"> & {
  workspace_id: string | null
  display_name: string | null
  paused_at: number | null
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

/** Every unrevoked enrollment of the owner's, one device each, with the workspaces assigned to its machine. */
export async function listHostDevices(database: D1Database, actorId: string, now: number): Promise<HostDevice[]> {
  const rows = await database.prepare(`
    select enrollment.enrollment_id, enrollment.host_id, enrollment.display_name, enrollment.last_seen_at,
      enrollment.expires_at, enrollment.paused_at, assignment.workspace_id,
      coalesce(enrollment.acked_workspace_ids, '[]') as acked_workspace_ids
    from host_enrollments enrollment
    left join host_workspace_assignments assignment on assignment.host_id = enrollment.host_id
      and assignment.owner_actor_id = enrollment.owner_actor_id
    where enrollment.owner_actor_id = ? and enrollment.revoked_at is null
    order by enrollment.last_seen_at desc, enrollment.enrollment_id, assignment.workspace_id
  `).bind(actorId).all<DeviceRow>()
  const devices = new Map<string, HostDevice>()
  for (const row of rows.results ?? []) {
    const device = devices.get(row.enrollment_id) ?? {
      host_id: row.host_id,
      enrollment_id: row.enrollment_id,
      display_name: row.display_name ?? row.host_id,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      state: row.paused_at !== null ? "paused" : row.expires_at > now ? "online" : "offline",
      workspace_ids: [],
      acked_workspace_ids: storedStringList(row.acked_workspace_ids),
    }
    if (row.workspace_id) device.workspace_ids.push(row.workspace_id)
    devices.set(row.enrollment_id, device)
  }
  return [...devices.values()]
}
