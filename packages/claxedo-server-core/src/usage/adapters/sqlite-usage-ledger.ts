import { createHash } from "node:crypto"
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db/index"
import {
  assertTurnUsageRevision,
  type TurnUsageQuality,
  type TurnUsageRevision,
  type UsageRevisionReader,
  type UsageRevisionWriter,
} from "../contracts"
import { ClaxedoUsageOutboxTable, ClaxedoUsageTurnCurrentTable, ClaxedoUsageTurnRevisionTable } from "../usage.sql"

type Database = {
  use<T>(callback: (db: ClaxedoDB.Client) => T): T
  transaction<T>(callback: (db: ClaxedoDB.Client) => T): T
}

type UsageRow = typeof ClaxedoUsageTurnRevisionTable.$inferSelect

function canonicalPayload(fact: TurnUsageRevision) {
  return JSON.stringify({
    hostId: fact.hostId,
    sessionRef: fact.sessionRef,
    sessionId: fact.sessionId,
    messageId: fact.messageId,
    revision: fact.revision,
    observedAt: fact.observedAt,
    completedAt: fact.completedAt ?? null,
    settlement: fact.settlement,
    status: fact.status,
    location: fact.location,
    harness: fact.harness,
    providerId: fact.providerId,
    modelId: fact.modelId,
    nativeSessionId: fact.nativeSessionId ?? null,
    workspaceId: fact.workspaceId ?? null,
    tokens: fact.tokens,
    quality: fact.quality,
  })
}

function payloadHash(fact: TurnUsageRevision) {
  return createHash("sha256").update(canonicalPayload(fact)).digest("hex")
}

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
    quality_json: JSON.stringify(fact.quality),
  }
}

function quality(input: string): TurnUsageQuality {
  const parsed = JSON.parse(input) as TurnUsageQuality
  return parsed
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
    settlement: row.settlement as TurnUsageRevision["settlement"],
    status: row.status as TurnUsageRevision["status"],
    location: row.location as TurnUsageRevision["location"],
    harness: row.harness,
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      cache: { read: row.cache_read_tokens, write: row.cache_write_tokens },
    },
    quality: quality(row.quality_json),
  }
}

export type SqliteUsageLedger = UsageRevisionWriter &
  UsageRevisionReader & {
    claimPending(
      identity: { org_id: string; user_id: string },
      input?: { limit?: number },
    ): Promise<TurnUsageRevision[]>
    markDelivered(fact: Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">): Promise<void>
    markConflict(fact: Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">): Promise<void>
  }

export function createSqliteUsageLedger(
  input: {
    database?: Database
    now?: () => number
  } = {},
): SqliteUsageLedger {
  const database = input.database ?? ClaxedoDB
  const now = input.now ?? Date.now
  return {
    async writeRevision(item) {
      assertTurnUsageRevision(item)
      const hash = payloadHash(item)
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
        }

        const row = values(item, hash)
        const priorOwner = db
          .select({
            org_id: ClaxedoUsageOutboxTable.org_id,
            user_id: ClaxedoUsageOutboxTable.user_id,
          })
          .from(ClaxedoUsageOutboxTable)
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.host_id, item.hostId),
              eq(ClaxedoUsageOutboxTable.session_ref, item.sessionRef),
              eq(ClaxedoUsageOutboxTable.message_id, item.messageId),
            ),
          )
          .orderBy(asc(ClaxedoUsageOutboxTable.created_at))
          .get()
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
        const stamp = now()
        db.insert(ClaxedoUsageOutboxTable)
          .values({
            host_id: item.hostId,
            session_ref: item.sessionRef,
            message_id: item.messageId,
            revision: item.revision,
            payload_hash: hash,
            ...(priorOwner?.org_id && priorOwner.user_id
              ? { org_id: priorOwner.org_id, user_id: priorOwner.user_id }
              : {}),
            state: "pending",
            attempts: 0,
            created_at: stamp,
            updated_at: stamp,
          })
          .run()
        return { status: "accepted" } as const
      })
    },

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

    async pendingOutbox(filter = {}) {
      const rows = database.use((db) => {
        const query = db
          .select({ usage: ClaxedoUsageTurnRevisionTable })
          .from(ClaxedoUsageOutboxTable)
          .innerJoin(
            ClaxedoUsageTurnRevisionTable,
            and(
              eq(ClaxedoUsageTurnRevisionTable.host_id, ClaxedoUsageOutboxTable.host_id),
              eq(ClaxedoUsageTurnRevisionTable.session_ref, ClaxedoUsageOutboxTable.session_ref),
              eq(ClaxedoUsageTurnRevisionTable.message_id, ClaxedoUsageOutboxTable.message_id),
              eq(ClaxedoUsageTurnRevisionTable.revision, ClaxedoUsageOutboxTable.revision),
            ),
          )
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.state, "pending"),
              filter.since === undefined ? undefined : gte(ClaxedoUsageTurnRevisionTable.observed_at, filter.since),
              filter.until === undefined ? undefined : lte(ClaxedoUsageTurnRevisionTable.observed_at, filter.until),
            ),
          )
          .orderBy(asc(ClaxedoUsageOutboxTable.created_at))
        return filter.all === true ? query.all() : query.limit(filter.limit ?? 100).all()
      })
      return rows.map((row) => fact(row.usage))
    },

    async claimPending(identity, filter = {}) {
      const limit = filter.limit ?? 100
      const rows = database.transaction((db) => {
        const unclaimed = db
          .select({
            host_id: ClaxedoUsageOutboxTable.host_id,
            session_ref: ClaxedoUsageOutboxTable.session_ref,
            message_id: ClaxedoUsageOutboxTable.message_id,
            revision: ClaxedoUsageOutboxTable.revision,
          })
          .from(ClaxedoUsageOutboxTable)
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.state, "pending"),
              isNull(ClaxedoUsageOutboxTable.org_id),
              isNull(ClaxedoUsageOutboxTable.user_id),
            ),
          )
          .orderBy(asc(ClaxedoUsageOutboxTable.created_at))
          .limit(limit)
          .all()
        for (const row of unclaimed) {
          db.update(ClaxedoUsageOutboxTable)
            .set(identity)
            .where(
              and(
                eq(ClaxedoUsageOutboxTable.host_id, row.host_id),
                eq(ClaxedoUsageOutboxTable.session_ref, row.session_ref),
                eq(ClaxedoUsageOutboxTable.message_id, row.message_id),
                eq(ClaxedoUsageOutboxTable.revision, row.revision),
                isNull(ClaxedoUsageOutboxTable.org_id),
                isNull(ClaxedoUsageOutboxTable.user_id),
              ),
            )
            .run()
        }
        return db
          .select({ usage: ClaxedoUsageTurnRevisionTable })
          .from(ClaxedoUsageOutboxTable)
          .innerJoin(
            ClaxedoUsageTurnRevisionTable,
            and(
              eq(ClaxedoUsageTurnRevisionTable.host_id, ClaxedoUsageOutboxTable.host_id),
              eq(ClaxedoUsageTurnRevisionTable.session_ref, ClaxedoUsageOutboxTable.session_ref),
              eq(ClaxedoUsageTurnRevisionTable.message_id, ClaxedoUsageOutboxTable.message_id),
              eq(ClaxedoUsageTurnRevisionTable.revision, ClaxedoUsageOutboxTable.revision),
            ),
          )
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.state, "pending"),
              eq(ClaxedoUsageOutboxTable.org_id, identity.org_id),
              eq(ClaxedoUsageOutboxTable.user_id, identity.user_id),
            ),
          )
          .orderBy(asc(ClaxedoUsageOutboxTable.created_at))
          .limit(limit)
          .all()
      })
      return rows.map((row) => fact(row.usage))
    },

    async markDelivered(item) {
      database.use((db) =>
        db
          .update(ClaxedoUsageOutboxTable)
          .set({
            state: "delivered",
            updated_at: now(),
          })
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.host_id, item.hostId),
              eq(ClaxedoUsageOutboxTable.session_ref, item.sessionRef),
              eq(ClaxedoUsageOutboxTable.message_id, item.messageId),
              eq(ClaxedoUsageOutboxTable.revision, item.revision),
            ),
          )
          .run(),
      )
    },
    async markConflict(item) {
      database.use((db) =>
        db
          .update(ClaxedoUsageOutboxTable)
          .set({
            state: "conflict",
            attempts: sql`${ClaxedoUsageOutboxTable.attempts} + 1`,
            updated_at: now(),
          })
          .where(
            and(
              eq(ClaxedoUsageOutboxTable.host_id, item.hostId),
              eq(ClaxedoUsageOutboxTable.session_ref, item.sessionRef),
              eq(ClaxedoUsageOutboxTable.message_id, item.messageId),
              eq(ClaxedoUsageOutboxTable.revision, item.revision),
            ),
          )
          .run(),
      )
    },
  }
}
