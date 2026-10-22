import type { D1Database } from "@cloudflare/workers-types"
import type { HostDirectRoutes, MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { parseJson } from "@claxedo/server-core/platform/json/index"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { stringList } from "./host-devices"

/**
 * Only an enrollment's current routes are kept: each beat that reports them
 * overwrites the row, a beat that reports none removes it, and a row whose
 * enrollment stopped serving is never read.
 */
export async function recordD1HostDirectRoutes(
  database: D1Database,
  machine: MachinePrincipal,
  routes: HostDirectRoutes | undefined,
  now: number,
): Promise<void> {
  if (!routes) {
    await database.prepare(`delete from host_direct_routes where enrollment_id = ?`).bind(machine.enrollmentId).run()
    return
  }
  await database.prepare(`
    insert into host_direct_routes (enrollment_id, port, addresses_json, spki_sha256, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict (enrollment_id) do update set
      port = excluded.port, addresses_json = excluded.addresses_json,
      spki_sha256 = excluded.spki_sha256, updated_at = excluded.updated_at
    where host_direct_routes.port <> excluded.port
      or host_direct_routes.addresses_json <> excluded.addresses_json
      or host_direct_routes.spki_sha256 <> excluded.spki_sha256
  `).bind(machine.enrollmentId, routes.port, JSON.stringify(routes.addresses), routes.spkiSha256, now).run()
}

/** The routes of the enrollment that serves the workspace now, under the same predicate every routing reader uses. */
export async function readD1HostDirectRoutes(
  database: D1Database,
  workspaceId: string,
  now: number,
): Promise<HostDirectRoutes | undefined> {
  const row = await database.prepare(`
    select routes.port, routes.addresses_json, routes.spki_sha256
    from host_workspace_assignments assignment
    inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
      and enrollment.owner_actor_id = assignment.owner_actor_id
    inner join host_direct_routes routes on routes.enrollment_id = enrollment.enrollment_id
    where assignment.workspace_id = ? and ${HOST_SERVING_WORKSPACE_SQL}
    limit 1
  `).bind(workspaceId, now).first<{ port: number; addresses_json: string; spki_sha256: string }>()
  if (!row) return undefined
  return { port: row.port, addresses: stringList(parseJson(row.addresses_json)), spkiSha256: row.spki_sha256 }
}
