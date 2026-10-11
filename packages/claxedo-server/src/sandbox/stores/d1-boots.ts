import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"

/** The predicate a lease write applies to `sandbox_leases`, with the values it binds. */
export type SandboxLeaseGuard = { sql: string; binds: readonly (string | number | null)[] }

/**
 * Records the boot a lease write ends, in `sandbox_boots`. It runs in the same batch as that write and ahead of it,
 * under the write's own guard, so a boot is recorded exactly when the write takes a serving epoch out of `ready`.
 * The interval is the one `workspace_stopped.active_ms` measures: the epoch's start to the write. An epoch that serves
 * again after an outage extends its own row rather than adding one.
 */
export function closeServingBoot(database: D1Database, guard: SandboxLeaseGuard, stoppedAt: number): D1PreparedStatement {
  return database.prepare(`
    insert into sandbox_boots (workspace_id, epoch, org_id, owner_user_id, machine_class, started_at, stopped_at)
    select l.workspace_id, l.epoch, w.org_id, w.owner_user_id, l.machine_class,
      min(json_extract(l.start_json, '$.startedAt'), ?1), ?1
    from (select * from sandbox_leases where ${guard.sql}) l
    join workspaces w on w.workspace_id = l.workspace_id
    where l.status = 'ready' and json_extract(l.start_json, '$.startedAt') is not null
    on conflict (workspace_id, epoch) do update set stopped_at = max(sandbox_boots.stopped_at, excluded.stopped_at)
  `).bind(stoppedAt, ...guard.binds)
}

export type MachineTimeQuery = { org_id: string; user_id: string; since: number; until: number }

/**
 * The machine time of one person's cloud workspaces in [since, until]: every ended boot clipped to the range, and
 * every epoch still serving from its start, or `since`, to `until`. Ended boots are read by the owner index; serving
 * ones through the person's workspaces to their lease rows.
 */
export async function readMachineTime(database: D1Database, query: MachineTimeQuery) {
  const row = await database.prepare(`
    with serving as (
      select max(json_extract(l.start_json, '$.startedAt'), ?3) as started_at
      from workspaces w join sandbox_leases l on l.workspace_id = w.workspace_id
      where w.owner_user_id = ?2 and w.org_id = ?1 and l.status = 'ready'
        and json_extract(l.start_json, '$.startedAt') < ?4
    )
    select
      (select coalesce(sum(min(stopped_at, ?4) - max(started_at, ?3)), 0) from sandbox_boots
        where org_id = ?1 and owner_user_id = ?2 and stopped_at > ?3 and started_at < ?4) as ended_ms,
      (select coalesce(sum(?4 - started_at), 0) from serving) as serving_ms,
      (select count(*) from serving) as running
  `).bind(query.org_id, query.user_id, query.since, query.until).first<{ ended_ms: number; serving_ms: number; running: number }>()
  return { activeMs: (row?.ended_ms ?? 0) + (row?.serving_ms ?? 0), running: row?.running ?? 0 }
}
