import type { D1Database } from "@cloudflare/workers-types"
import {
  assertTurnUsageRevision,
  readTurnUsageQuality,
  TURN_USAGE_LOCATIONS,
  TURN_USAGE_SETTLEMENTS,
  TURN_USAGE_STATUSES,
  usageRevisionHash,
  type TurnUsageRevision,
  type UsageRevisionWriteResult,
} from "@claxedo/server-core/usage/contracts"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import {
  USAGE_BREAKDOWN_DIMENSIONS,
  usageDateFormatter,
  type CentralUsageProjection,
  type CentralUsageRow,
  type UsageBreakdownDimension,
} from "@claxedo/server-core/usage/projection"
import { USAGE_REPORT_MAX_MESSAGES_PER_TURN, type UsageReportWriter } from "@claxedo/server-core/usage/usage-report"
import { isOneOf, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"

type FactRow = {
  host_id: string
  session_ref: string
  session_id: string
  message_id: string
  revision: number
  observed_at: number
  completed_at: number | null
  settlement: string
  status: string
  location: string
  harness: string
  provider_id: string
  model_id: string
  native_session_id: string | null
  workspace_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cache_write_1h_tokens: number | null
  quality_json: string
}

type CurrentRow = { revision: number; payload_hash: string }

function usageFactFromRow(row: FactRow): TurnUsageRevision | undefined {
  const { settlement, status, location } = row
  if (
    !isOneOf(settlement, TURN_USAGE_SETTLEMENTS)
    || !isOneOf(status, TURN_USAGE_STATUSES)
    || !isOneOf(location, TURN_USAGE_LOCATIONS)
  ) return undefined
  return {
    hostId: row.host_id,
    sessionRef: row.session_ref,
    sessionId: row.session_id,
    messageId: row.message_id,
    revision: row.revision,
    observedAt: row.observed_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    settlement,
    status,
    location,
    harness: row.harness,
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      cache: {
        read: row.cache_read_tokens,
        write: row.cache_write_tokens,
        ...(row.cache_write_1h_tokens === null ? {} : { write1h: row.cache_write_1h_tokens }),
      },
    },
    quality: readTurnUsageQuality(parseJsonRecord(row.quality_json)),
  }
}

/** Where `item` stands against the stored revision, or nothing when it is newer and should be written. */
function against(item: TurnUsageRevision, hash: string, current: CurrentRow | null): UsageRevisionWriteResult | undefined {
  if (!current || item.revision > current.revision) return undefined
  if (item.revision < current.revision) return { status: "stale", currentRevision: current.revision }
  return current.payload_hash === hash ? { status: "duplicate" } : { status: "conflict", currentRevision: current.revision }
}

const MODEL_SQL = "case when instr(model_id, '/') > 0 then model_id else provider_id || '/' || model_id end"
const LOCATION_SQL = "case when location = 'local' then 'local' else 'cloud' end"

/** Each dimension as `usageFactDimension` reads it off a revision, spelled over a stored row. */
const DIMENSION_SQL: Record<UsageBreakdownDimension, string> = {
  provider: "provider_id",
  harness: "harness",
  model: MODEL_SQL,
  location: LOCATION_SQL,
  session: "session_ref",
  workspace: "coalesce(nullif(workspace_id, ''), 'unavailable')",
}

const METRIC_COLUMNS = [
  "turn_count",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_1h_tokens",
  "input_known_count",
  "output_known_count",
  "reasoning_known_count",
  "cache_read_known_count",
  "cache_write_known_count",
  "unknown_token_count",
  "partial_turn_count",
  "unavailable_turn_count",
  "error_turn_count",
] as const

type Metrics = Record<(typeof METRIC_COLUMNS)[number], number>

const noMetrics = (): Metrics => ({
  turn_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cache_write_1h_tokens: 0,
  input_known_count: 0,
  output_known_count: 0,
  reasoning_known_count: 0,
  cache_read_known_count: 0,
  cache_write_known_count: 0,
  unknown_token_count: 0,
  partial_turn_count: 0,
  unavailable_turn_count: 0,
  error_turn_count: 0,
})

// `total()` rather than `sum()`: SQLite's integer `sum()` throws on overflow,
// and one account's rows must not be able to fail its whole dashboard.
const METRICS_SQL = `
  count(*) as turn_count,
  total(input_tokens) as input_tokens,
  total(output_tokens) as output_tokens,
  total(reasoning_tokens) as reasoning_tokens,
  total(cache_read_tokens) as cache_read_tokens,
  total(cache_write_tokens) as cache_write_tokens,
  total(cache_write_1h_tokens) as cache_write_1h_tokens,
  count(input_tokens) as input_known_count,
  count(output_tokens) as output_known_count,
  count(reasoning_tokens) as reasoning_known_count,
  count(cache_read_tokens) as cache_read_known_count,
  count(cache_write_tokens) as cache_write_known_count,
  sum((input_tokens is null) + (output_tokens is null) + (reasoning_tokens is null)
    + (cache_read_tokens is null) + (cache_write_tokens is null)) as unknown_token_count,
  sum(settlement = 'partial') as partial_turn_count,
  sum(settlement <> 'provisional' and (settlement = 'unavailable' or not exists (
    select 1 from json_each(quality_json, '$.knownCategories')
    where value in ('input', 'output', 'reasoning', 'cache_read', 'cache_write')
  ))) as unavailable_turn_count,
  sum(status = 'error') as error_turn_count
`

type GroupRow = Metrics & { date: string; model: string; location: string; dimension: string }

type FilterOptionRow = Record<UsageBreakdownDimension, string>

const HOUR_MS = 3_600_000

/**
 * The local days `[since, until]` spans in `timeZone`, each as its date and
 * the half-open millisecond range it covers, dated by the same formatter the
 * usage series use. A local day is at least 23 hours long, so an hourly probe
 * crosses each midnight once, and a binary search places it to the
 * millisecond.
 */
function localDays(since: number, until: number, timeZone: string): Array<[date: string, start: number, end: number]> {
  if (until < since) return []
  const format = usageDateFormatter(timeZone)
  const dateOf = (at: number) => format.format(new Date(at))
  const days: Array<[string, number, number]> = []
  let day = dateOf(since)
  let start = since
  let low = since
  for (;;) {
    const probe = Math.min(low + HOUR_MS, until)
    if (dateOf(probe) !== day) {
      let high = probe
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (dateOf(middle) === day) low = middle
        else high = middle
      }
      days.push([day, start, high])
      day = dateOf(high)
      start = high
      low = high
      continue
    }
    if (probe === until) {
      days.push([day, start, until + 1])
      return days
    }
    low = probe
  }
}

/** Sums grouped rows into one row per `identity`, ordered by it. */
function rollUp(rows: readonly GroupRow[], identity: (row: GroupRow) => Record<string, string>): CentralUsageRow[] {
  const grouped = new Map<string, { fields: Record<string, string>; metrics: Metrics }>()
  for (const row of rows) {
    const fields = identity(row)
    const key = JSON.stringify(Object.values(fields))
    const existing = grouped.get(key) ?? { fields, metrics: noMetrics() }
    grouped.set(key, existing)
    for (const name of METRIC_COLUMNS) existing.metrics[name] += row[name]
  }
  return [...grouped]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => ({ ...row.fields, ...row.metrics }))
}

export type D1UsageLedger = UsageReportWriter
  & Required<Pick<UsageProjectionLedger, "usageDashboard" | "cloudUsageFacts">>

/**
 * The hosted plane's usage store: the latest revision of every reported turn,
 * owned by the account that produced it. It answers the signed account's
 * cross-machine view and nothing wider — every read is keyed by one
 * organization and one user.
 */
export function createD1UsageLedger(input: { database: D1Database; now?: () => number }): D1UsageLedger {
  const { database } = input
  const now = input.now ?? Date.now
  const current = (item: TurnUsageRevision) => database
    .prepare("select revision, payload_hash from usage_turn_facts where host_id = ? and session_ref = ? and message_id = ?")
    .bind(item.hostId, item.sessionRef, item.messageId)
    .first<CurrentRow>()
  return {
    async writeRevision(item, filing) {
      assertTurnUsageRevision(item)
      if (!filing?.owner || !filing.turnId) throw new Error("A central usage revision requires the account and the turn that produced it")
      const { owner, turnId } = filing
      const hash = await usageRevisionHash(item)
      const settled = against(item, hash, await current(item))
      if (settled) return settled
      // One statement, so the count a new message is admitted against is
      // the one it is inserted under: two reports racing for a turn's last
      // slot cannot both take it. A later revision never refiles a message:
      // the sandbox names the turn, and could name another member's.
      const written = await database.prepare(`
        insert into usage_turn_facts (
          host_id, session_ref, session_id, message_id, revision, payload_hash, org_id, user_id, turn_id, workspace_id,
          observed_at, completed_at, settlement, status, location, harness, provider_id, model_id, native_session_id,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
          quality_json, recorded_at
        )
        select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
        where exists (select 1 from usage_turn_facts where host_id = ?1 and session_ref = ?2 and message_id = ?4)
          or (select count(*) from usage_turn_facts where host_id = ?1 and session_ref = ?2 and turn_id = ?9) < ?28
        on conflict (host_id, session_ref, message_id) do update set
          session_id = excluded.session_id, revision = excluded.revision, payload_hash = excluded.payload_hash,
          workspace_id = excluded.workspace_id,
          observed_at = excluded.observed_at, completed_at = excluded.completed_at, settlement = excluded.settlement,
          status = excluded.status, location = excluded.location, harness = excluded.harness,
          provider_id = excluded.provider_id, model_id = excluded.model_id, native_session_id = excluded.native_session_id,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens, cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens, cache_write_1h_tokens = excluded.cache_write_1h_tokens,
          quality_json = excluded.quality_json, recorded_at = excluded.recorded_at
        where excluded.revision > usage_turn_facts.revision
      `).bind(
        item.hostId,
        item.sessionRef,
        item.sessionId,
        item.messageId,
        item.revision,
        hash,
        owner.org_id,
        owner.user_id,
        turnId,
        item.workspaceId ?? null,
        item.observedAt,
        item.completedAt ?? null,
        item.settlement,
        item.status,
        item.location,
        item.harness,
        item.providerId,
        item.modelId,
        item.nativeSessionId ?? null,
        item.tokens.input,
        item.tokens.output,
        item.tokens.reasoning,
        item.tokens.cache.read,
        item.tokens.cache.write,
        item.tokens.cache.write1h ?? null,
        JSON.stringify(item.quality),
        now(),
        USAGE_REPORT_MAX_MESSAGES_PER_TURN,
      ).run()
      if (written.meta.changes > 0) return { status: "accepted" }
      const after = await current(item)
      if (!after) return { status: "refused", code: "usage_turn_full" }
      // A concurrent report landed between the read and the write; the row it
      // left decides this one.
      return against(item, hash, after) ?? { status: "stale", currentRevision: after.revision }
    },

    /**
     * Grouped in SQL by local day, model, location and the requested
     * dimension, so the Worker receives one row per group rather than one per
     * turn, whatever the range.
     */
    async usageDashboard(query) {
      const timeZone = query.timeZone ?? "UTC"
      const dimension = query.dimension
      const filters = Object.entries(query.filters ?? {}).flatMap(([name, value]) =>
        value && isOneOf(name, USAGE_BREAKDOWN_DIMENSIONS) ? [[DIMENSION_SQL[name], value] as const] : [])
      const owned = "org_id = ? and user_id = ? and observed_at >= ? and observed_at <= ?"
      const range = [query.org_id, query.user_id, query.since, query.until]
      const [grouped, options] = await Promise.all([
        database.prepare(`
          with days (date, start_at, end_at) as (
            select json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') from json_each(?)
          )
          select days.date as date, ${MODEL_SQL} as model, ${LOCATION_SQL} as location,
            ${dimension ? DIMENSION_SQL[dimension] : "''"} as dimension, ${METRICS_SQL}
          from usage_turn_facts
          join days on observed_at >= days.start_at and observed_at < days.end_at
          where ${owned}${filters.map(([sql]) => ` and ${sql} = ?`).join("")}
          group by 1, 2, 3, 4
        `).bind(JSON.stringify(localDays(query.since, query.until, timeZone)), ...range, ...filters.map(([, value]) => value))
          .all<GroupRow>(),
        database.prepare(`
          select distinct ${USAGE_BREAKDOWN_DIMENSIONS.map((name) => `${DIMENSION_SQL[name]} as ${name}`).join(", ")}
          from usage_turn_facts where ${owned}
        `).bind(...range).all<FilterOptionRow>(),
      ])
      const rows = grouped.results
      const values = (name: UsageBreakdownDimension) => [...new Set(options.results.map((row) => row[name]))].toSorted()
      const projection: CentralUsageProjection = {
        totals: rollUp(rows, () => ({}))[0] ?? {},
        daily: rollUp(rows, (row) => ({ date: row.date })),
        models: rollUp(rows, (row) => ({ value: row.model })),
        dailyModels: rollUp(rows, (row) => ({ date: row.date, value: row.model })),
        locations: rollUp(rows, (row) => ({ value: row.location })),
        ...(dimension
          ? {
              breakdown: rollUp(rows, (row) => ({ value: row.dimension })),
              dailyBreakdown: rollUp(rows, (row) => ({ date: row.date, value: row.dimension })),
              breakdownModels: rollUp(rows, (row) => ({ group: row.dimension, value: row.model })),
            }
          : {}),
        filters: {
          provider: values("provider"),
          harness: values("harness"),
          model: values("model"),
          location: values("location"),
          session: values("session"),
          workspace: values("workspace"),
        },
      }
      return projection
    },

    async cloudUsageFacts(query) {
      const rows = await database.prepare(`
        select * from usage_turn_facts
        where org_id = ? and user_id = ? and location = 'cloud-workspace' and observed_at >= ? and observed_at <= ?
        order by observed_at
        limit ?
      `).bind(query.org_id, query.user_id, query.since, query.until, query.limit).all<FactRow>()
      return rows.results.flatMap((row) => usageFactFromRow(row) ?? [])
    },
  }
}
