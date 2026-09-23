import { and, asc, eq, gte, lte, sql } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db/index"
import {
  assertTurnUsageRevision,
  readTurnUsageQuality,
  usageRevisionHash,
  type TurnUsageQuality,
  type TurnUsageRevision,
  type UsageOwnedTurnReader,
  type UsageOwner,
  type UsageRevisionReader,
  type UsageRevisionWriteResult,
  type UsageRevisionWriter,
} from "../contracts"
import type { LocalTurnSpan } from "../local-history-classifier"
import { USAGE_REPORT_MAX_MESSAGES_PER_TURN, type UsageReportWriter } from "../usage-report"
import { ClaxedoUsageTurnCurrentTable, ClaxedoUsageTurnOwnerTable, ClaxedoUsageTurnRevisionTable } from "../usage.sql"

type Database = {
  use<T>(callback: (db: ClaxedoDB.Client) => T): T
  transaction<T>(callback: (db: ClaxedoDB.Client) => T): T
}

type UsageRow = typeof ClaxedoUsageTurnRevisionTable.$inferSelect

function values(fact: TurnUsageRevision, hash: string): typeof ClaxedoUsageTurnRevisionTable.$inferInsert {
  return {
    host_id: fact.hostId,
    session_ref: fact.sessionRef,
    session_id: fact.sessionId,
    message_id: fact.messageId,
    revision: fact.revision,
    payload_hash: hash,
    observed_at: fact.observedAt,
    completed_at: fact.completedAt ?? null,
    settlement: fact.settlement,
    status: fact.status,
    location: fact.location,
    harness: fact.harness,
    provider_id: fact.providerId,
    model_id: fact.modelId,
    native_session_id: fact.nativeSessionId ?? null,
    workspace_id: fact.workspaceId ?? null,
    input_tokens: fact.tokens.input,
    output_tokens: fact.tokens.output,
    reasoning_tokens: fact.tokens.reasoning,
    cache_read_tokens: fact.tokens.cache.read,
    cache_write_tokens: fact.tokens.cache.write,
    cache_write_1h_tokens: fact.tokens.cache.write1h ?? null,
    quality_json: JSON.stringify(fact.quality),
  }
}

function quality(input: string): TurnUsageQuality {
  return readTurnUsageQuality(JSON.parse(input))
}

function fact(row: UsageRow): TurnUsageRevision {
  return {
    hostId: row.host_id,
    sessionRef: row.session_ref,
    sessionId: row.session_id,
    messageId: row.message_id,
    revision: row.revision,
    observedAt: row.observed_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    settlement: row.settlement,
    status: row.status,
    location: row.location,
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
    quality: quality(row.quality_json),
  }
}

export type SqliteUsageLedger = UsageRevisionWriter &
  UsageRevisionReader &
  UsageOwnedTurnReader & {
    /** The latest revision of every turn metered on this machine, with when its first revision was observed. */
    localTurnSpans(): Promise<LocalTurnSpan[]>
    /** Where the plane files what a cloud sandbox this machine provisions reports, each turn up to its message cap. */
    reports: UsageReportWriter
  }

type TurnFull = { status: "refused"; code: "usage_turn_full" }

export function createSqliteUsageLedger(
  input: {
    database?: Database
  } = {},
): SqliteUsageLedger {
  const database = input.database ?? ClaxedoDB
  function write(item: TurnUsageRevision, filing: { owner?: UsageOwner }): Promise<UsageRevisionWriteResult>
  function write(item: TurnUsageRevision, filing: { owner: UsageOwner; turnId: string }): Promise<UsageRevisionWriteResult | TurnFull>
  async function write(item: TurnUsageRevision, filing: { owner?: UsageOwner; turnId?: string }) {
    assertTurnUsageRevision(item)
    const hash = await usageRevisionHash(item)
    return database.transaction((db) => {
      const current = db
        .select({
          revision: ClaxedoUsageTurnCurrentTable.revision,
          payload_hash: ClaxedoUsageTurnCurrentTable.payload_hash,
        })
        .from(ClaxedoUsageTurnCurrentTable)
        .where(
          and(
            eq(ClaxedoUsageTurnCurrentTable.host_id, item.hostId),
            eq(ClaxedoUsageTurnCurrentTable.session_ref, item.sessionRef),
            eq(ClaxedoUsageTurnCurrentTable.message_id, item.messageId),
          ),
        )
        .get()
      if (current) {
        if (item.revision < current.revision) return { status: "stale", currentRevision: current.revision } as const
        if (item.revision === current.revision) {
          return current.payload_hash === hash
            ? ({ status: "duplicate" } as const)
            : ({ status: "conflict", currentRevision: current.revision } as const)
        }
      } else if (filing.turnId !== undefined) {
        const filed = db
          .select({ messages: sql<number>`count(*)` })
          .from(ClaxedoUsageTurnOwnerTable)
          .where(
            and(
              eq(ClaxedoUsageTurnOwnerTable.host_id, item.hostId),
              eq(ClaxedoUsageTurnOwnerTable.session_ref, item.sessionRef),
              eq(ClaxedoUsageTurnOwnerTable.turn_id, filing.turnId),
            ),
          )
          .get()
        if ((filed?.messages ?? 0) >= USAGE_REPORT_MAX_MESSAGES_PER_TURN) {
          return { status: "refused", code: "usage_turn_full" } as const
        }
      }

      const row = values(item, hash)
      db.insert(ClaxedoUsageTurnRevisionTable).values(row).run()
      db.insert(ClaxedoUsageTurnCurrentTable)
        .values(row)
        .onConflictDoUpdate({
          target: [
            ClaxedoUsageTurnCurrentTable.host_id,
            ClaxedoUsageTurnCurrentTable.session_ref,
            ClaxedoUsageTurnCurrentTable.message_id,
          ],
          set: row,
        })
        .run()
      // A revision written before its session's producer could be named
      // leaves the turn's owner as an earlier revision stamped it. A reported
      // message keeps the owner and turn it was first filed under: a later
      // revision names its turn from the sandbox, which could name another.
      const { owner, turnId } = filing
      if (owner) {
        const stamp = { org_id: owner.org_id, user_id: owner.user_id, ...(turnId === undefined ? {} : { turn_id: turnId }) }
        const target = [
          ClaxedoUsageTurnOwnerTable.host_id,
          ClaxedoUsageTurnOwnerTable.session_ref,
          ClaxedoUsageTurnOwnerTable.message_id,
        ]
        const filed = db.insert(ClaxedoUsageTurnOwnerTable)
          .values({ host_id: item.hostId, session_ref: item.sessionRef, message_id: item.messageId, ...stamp })
        if (turnId === undefined) filed.onConflictDoUpdate({ target, set: stamp }).run()
        else filed.onConflictDoNothing({ target }).run()
      }
      return { status: "accepted" } as const
    })
  }

  return {
    writeRevision: (item, options) => write(item, options?.owner ? { owner: options.owner } : {}),
    reports: { writeRevision: (item, filing) => write(item, filing) },

    async current(filter = {}) {
      return database
        .use((db) =>
          db
            .select()
            .from(ClaxedoUsageTurnCurrentTable)
            .where(
              and(
                filter.hostId ? eq(ClaxedoUsageTurnCurrentTable.host_id, filter.hostId) : undefined,
                filter.sessionRef ? eq(ClaxedoUsageTurnCurrentTable.session_ref, filter.sessionRef) : undefined,
                filter.sessionId ? eq(ClaxedoUsageTurnCurrentTable.session_id, filter.sessionId) : undefined,
                filter.messageId ? eq(ClaxedoUsageTurnCurrentTable.message_id, filter.messageId) : undefined,
                filter.settlement ? eq(ClaxedoUsageTurnCurrentTable.settlement, filter.settlement) : undefined,
                filter.since === undefined ? undefined : gte(ClaxedoUsageTurnCurrentTable.observed_at, filter.since),
                filter.until === undefined ? undefined : lte(ClaxedoUsageTurnCurrentTable.observed_at, filter.until),
              ),
            )
            .orderBy(asc(ClaxedoUsageTurnCurrentTable.observed_at))
            .all(),
        )
        .map(fact)
    },

    async localTurnSpans() {
      const revisions = ClaxedoUsageTurnRevisionTable
      const current = ClaxedoUsageTurnCurrentTable
      const rows = database.use((db) =>
        db
          .select({
            usage: current,
            startedAt: sql<number>`(
              select min(${revisions.observed_at}) from ${revisions}
              where ${revisions.host_id} = ${current.host_id}
                and ${revisions.session_ref} = ${current.session_ref}
                and ${revisions.message_id} = ${current.message_id}
            )`,
          })
          .from(current)
          .where(eq(current.location, "local"))
          .orderBy(asc(current.observed_at))
          .all(),
      )
      return rows.map((row) => ({ fact: fact(row.usage), startedAt: row.startedAt }))
    },

    async ownedBy(owner, range = {}) {
      const rows = database.use((db) =>
        db
          .select({ usage: ClaxedoUsageTurnCurrentTable })
          .from(ClaxedoUsageTurnOwnerTable)
          .innerJoin(
            ClaxedoUsageTurnCurrentTable,
            and(
              eq(ClaxedoUsageTurnCurrentTable.host_id, ClaxedoUsageTurnOwnerTable.host_id),
              eq(ClaxedoUsageTurnCurrentTable.session_ref, ClaxedoUsageTurnOwnerTable.session_ref),
              eq(ClaxedoUsageTurnCurrentTable.message_id, ClaxedoUsageTurnOwnerTable.message_id),
            ),
          )
          .where(
            and(
              eq(ClaxedoUsageTurnOwnerTable.org_id, owner.org_id),
              eq(ClaxedoUsageTurnOwnerTable.user_id, owner.user_id),
              range.since === undefined ? undefined : gte(ClaxedoUsageTurnCurrentTable.observed_at, range.since),
              range.until === undefined ? undefined : lte(ClaxedoUsageTurnCurrentTable.observed_at, range.until),
            ),
          )
          .orderBy(asc(ClaxedoUsageTurnCurrentTable.observed_at))
          .all(),
      )
      return rows.map((row) => fact(row.usage))
    },
  }
}
