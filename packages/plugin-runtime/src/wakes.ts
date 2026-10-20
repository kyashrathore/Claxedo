import type { SqlStorage } from "@cloudflare/workers-types"
import { PLUGIN_WAKE_LIMITS, type PluginPlatformAnswer, type PluginWake } from "@claxedo/plugin-api/backend"
import { jsonByteLength } from "@claxedo/plugin-api/backend-schema"
import { refusedCall } from "./platform-admission"

export type WakeStore = Readonly<{
  sql: Pick<SqlStorage, "exec">
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}>

type WakeRow = { name: string; at: number; payload_json: string | null }

function wakeOf(row: WakeRow): PluginWake {
  return { name: row.name, at: row.at, ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) as unknown }) }
}

/**
 * One plugin's scheduled wakes, in its supervisor's own storage and on the
 * supervisor's own alarm: the alarm reaches platform code, never a facet, so
 * a deactivated plugin's wake runs nothing of the plugin. A wake is taken off
 * the table before it is delivered, so it runs at most once.
 */
export class PluginWakes {
  constructor(
    private readonly store: WakeStore,
    private readonly now: () => number = Date.now,
  ) {}

  createSchema() {
    this.store.sql.exec("create table if not exists plugin_wakes (name text primary key, at integer not null, payload_json text)")
  }

  async at(name: string, at: number, payload: unknown): Promise<PluginPlatformAnswer> {
    if (at < this.now() + PLUGIN_WAKE_LIMITS.minLeadMs) {
      return refusedCall(400, "plugin_wake_too_soon", `A wake is set at least ${PLUGIN_WAKE_LIMITS.minLeadMs} ms ahead`)
    }
    if (jsonByteLength(payload) > PLUGIN_WAKE_LIMITS.payloadBytes) {
      return refusedCall(413, "plugin_wake_payload_too_large", `A wake's payload is at most ${PLUGIN_WAKE_LIMITS.payloadBytes} bytes of JSON`)
    }
    const [counted] = this.store.sql.exec<{ count: number; mine: number }>("select count(*) as count, coalesce(sum(name = ?), 0) as mine from plugin_wakes", name).toArray()
    if ((counted?.count ?? 0) - (counted?.mine ?? 0) >= PLUGIN_WAKE_LIMITS.count) {
      return refusedCall(429, "plugin_wake_limit", `A plugin holds at most ${PLUGIN_WAKE_LIMITS.count} wakes`)
    }
    this.store.sql.exec(
      "insert into plugin_wakes (name, at, payload_json) values (?, ?, ?) on conflict (name) do update set at = excluded.at, payload_json = excluded.payload_json",
      name,
      at,
      payload === undefined ? null : JSON.stringify(payload),
    )
    await this.rearm()
    return { ok: true }
  }

  async cancel(name: string): Promise<PluginPlatformAnswer> {
    this.store.sql.exec("delete from plugin_wakes where name = ?", name)
    await this.rearm()
    return { ok: true }
  }

  list(): PluginWake[] {
    return this.store.sql.exec<WakeRow>("select name, at, payload_json from plugin_wakes order by at, name").toArray().map(wakeOf)
  }

  /** Every wake due at `now`, removed from the table, with the alarm moved to the next one. */
  async takeDue(now: number): Promise<PluginWake[]> {
    const due = this.store.sql.exec<WakeRow>("select name, at, payload_json from plugin_wakes where at <= ? order by at, name", now).toArray().map(wakeOf)
    this.store.sql.exec("delete from plugin_wakes where at <= ?", now)
    await this.rearm()
    return due
  }

  async rearm() {
    const [next] = this.store.sql.exec<{ at: number | null }>("select min(at) as at from plugin_wakes").toArray()
    if (next?.at == null) await this.store.deleteAlarm()
    else await this.store.setAlarm(next.at)
  }
}
