import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"

/** The predicate a lease write applies to `sandbox_leases`, with the values it binds. */
export type SandboxLeaseGuard = { sql: string; binds: readonly (string | number | null)[] }

/**
 * A lease row the provider bills a host for: one serving, or one still booting on a host the driver already
 * reported. A row whose attempt failed or that was stopped holds its host archived, which costs nothing.
 */
const HOSTED = "(l.status = 'ready' or (l.status in ('pending', 'acquiring', 'starting') and l.sandbox_id is not null))"

/**
 * Records the boot a lease write ends, in `sandbox_boots`. It runs in the same batch as that write and ahead of it,
 * under the write's own guard, so a boot is recorded exactly when the write takes an epoch off the host it holds,
 * whether its runtime served or its boot failed on it. The interval is the one `workspace_stopped.active_ms`
 * measures: the epoch's start to the write. An epoch that serves again after an outage extends its own row rather
 * than adding one; a retried boot takes an epoch of its own. The driver and machine class travel with the boot
 * because they are what it is priced by, and the lease that named them is rewritten by the next boot. A boot that
 * failed keeps the reason, which the lease loses to the next epoch's acquire; a later close of the epoch keeps it too.
 */
export function closeBoot(database: D1Database, guard: SandboxLeaseGuard, stoppedAt: number, error?: string): D1PreparedStatement {
  return database.prepare(`
    insert into sandbox_boots (workspace_id, epoch, org_id, owner_user_id, driver, machine_class, started_at, stopped_at, error)
    select l.workspace_id, l.epoch, w.org_id, w.owner_user_id, l.driver, l.machine_class,
      min(json_extract(l.start_json, '$.startedAt'), ?1), ?1, ?2
    from (select * from sandbox_leases where ${guard.sql}) l
    join workspaces w on w.workspace_id = l.workspace_id
    where ${HOSTED} and json_extract(l.start_json, '$.startedAt') is not null
    on conflict (workspace_id, epoch) do update set stopped_at = max(sandbox_boots.stopped_at, excluded.stopped_at),
      error = coalesce(excluded.error, sandbox_boots.error)
  `).bind(stoppedAt, error ?? null, ...guard.binds)
}

export type MachineTimeQuery = { org_id: string; user_id: string; since: number; until: number }

/** One workspace's machine time on one driver and machine class within the queried range. */
export type MachineTimeRow = {
  workspace_id: string
  project_id: string | null
  display_name: string | null
  git_branch: string | null
  driver: string
  machine_class: string | null
  active_ms: number
  /** The start of the epoch still on a host at `until`, where one is. */
  running_since: number | null
  /** When the latest boot in the range ended, where one did. */
  last_stopped_at: number | null
}

/**
 * The machine time of one person's cloud workspaces in [since, until], per workspace, driver and machine class: every
 * ended boot clipped to the range, and every epoch still on a host from its start, or `since`, to `until`. Ended boots
 * are read by the owner index; hosted ones through the person's workspaces to their lease rows. A workspace that
 * changed size within the range is two rows.
 */
export async function readMachineTime(database: D1Database, query: MachineTimeQuery): Promise<MachineTimeRow[]> {
  const rows = await database.prepare(`
    with hosted as (
      select l.workspace_id, l.driver, l.machine_class,
        ?4 - max(json_extract(l.start_json, '$.startedAt'), ?3) as active_ms,
        json_extract(l.start_json, '$.startedAt') as running_since, null as last_stopped_at
      from workspaces w join sandbox_leases l on l.workspace_id = w.workspace_id
      where w.owner_user_id = ?2 and w.org_id = ?1 and ${HOSTED}
        and json_extract(l.start_json, '$.startedAt') < ?4
    ),
    ended as (
      select workspace_id, driver, machine_class, min(stopped_at, ?4) - max(started_at, ?3) as active_ms, null as running_since, stopped_at as last_stopped_at
      from sandbox_boots
      where org_id = ?1 and owner_user_id = ?2 and stopped_at > ?3 and started_at < ?4
    ),
    spent as (
      select * from ended union all select * from hosted
    )
    select s.workspace_id, w.project_id, w.display_name, w.git_branch, s.driver, s.machine_class,
      sum(s.active_ms) as active_ms, max(s.running_since) as running_since, max(s.last_stopped_at) as last_stopped_at
    from spent s left join workspaces w on w.workspace_id = s.workspace_id
    group by s.workspace_id, s.driver, s.machine_class
  `).bind(query.org_id, query.user_id, query.since, query.until).all<MachineTimeRow>()
  return rows.results
}
