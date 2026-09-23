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
  type UsageRevisionWriter,
} from "@claxedo/server-core/usage/contracts"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import { centralUsageProjection } from "@claxedo/server-core/usage/projection"
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

export type D1UsageLedger = UsageRevisionWriter
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
    async writeRevision(item, options) {
      assertTurnUsageRevision(item)
      const owner = options?.owner
      if (!owner) throw new Error("A central usage revision requires the account that produced it")
      const hash = await usageRevisionHash(item)
      const settled = against(item, hash, await current(item))
      if (settled) return settled
      const written = await database.prepare(`
        insert into usage_turn_facts (
          host_id, session_ref, session_id, message_id, revision, payload_hash, org_id, user_id, workspace_id,
          observed_at, completed_at, settlement, status, location, harness, provider_id, model_id, native_session_id,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
          quality_json, recorded_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (host_id, session_ref, message_id) do update set
          session_id = excluded.session_id, revision = excluded.revision, payload_hash = excluded.payload_hash,
          org_id = excluded.org_id, user_id = excluded.user_id, workspace_id = excluded.workspace_id,
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
      ).run()
      if (written.meta.changes > 0) return { status: "accepted" }
      // A concurrent report landed between the read and the write; the row it
      // left decides this one.
      const after = await current(item)
      return against(item, hash, after) ?? { status: "stale", currentRevision: after?.revision ?? item.revision }
    },

    async usageDashboard(query) {
      const rows = await database.prepare(`
        select * from usage_turn_facts
        where org_id = ? and user_id = ? and observed_at >= ? and observed_at <= ?
        order by observed_at
      `).bind(query.org_id, query.user_id, query.since, query.until).all<FactRow>()
      return centralUsageProjection({
        facts: rows.results.flatMap((row) => usageFactFromRow(row) ?? []),
        since: query.since,
        until: query.until,
        timeZone: query.timeZone ?? "UTC",
        ...(query.dimension ? { dimension: query.dimension } : {}),
        ...(query.filters ? { filters: query.filters } : {}),
      })
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
