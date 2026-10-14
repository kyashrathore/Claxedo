import type { SqliteDatabase, SqliteStatement } from "@claxedo/session-core"
import {
  assertTurnUsageRevision,
  usageRevisionHash,
  type TurnUsageRevision,
  type TurnUsageSettlement,
  type UsageRevisionWriteResult,
} from "./contracts"
import { readTurnMeterState, type TurnMeterStateStore } from "./turn-meter-state"
import { cloudWorkspaceUsageRevision, readUsageReportRevision, usageReportRevision, type UsageReportFact, type UsageReportResult } from "./usage-report"

/** A turn lease's turn: the session holding the lease and the turn it admitted. */
export type MeteringTurn = { sessionId: string; turnId: string }

/**
 * A fact to report, and the session and message it was metered on: the plane
 * answers by the fact's reported message id, the ledger settles by these.
 */
export type PendingUsageFact = { sessionId: string; messageId: string; fact: UsageReportFact }

export type ReportResult = Pick<UsageReportResult, "messageId" | "revision" | "status">

const DELIVERY = {
  accepted: "delivered",
  duplicate: "delivered",
  stale: "stale",
  conflict: "conflict",
  refused: "refused",
} as const satisfies Record<ReportResult["status"], string>

/**
 * The message id a fact is reported under. The plane files every fact under
 * the session whose turn carried it, keyed by message id, and a descendant's
 * message id is unique only within its own session: an ACP agent names its
 * own messages, so a grandchild can reuse its parent's. Qualifying a
 * descendant's id by its session keeps its fact from answering as, or
 * replacing, another fact filed under that turn's session.
 */
function reportedMessageId(input: { sessionId: string; turnSessionId: string; messageId: string }) {
  return input.sessionId === input.turnSessionId ? input.messageId : `${input.sessionId}/${input.messageId}`
}

type CurrentFilter = { sessionId?: string; messageId?: string; settlement?: TurnUsageSettlement }

export type RuntimeUsageLedger = {
  /**
   * Records a revision as metered under `turn`. A message keeps the turn its
   * first revision was recorded under, so a revision written after that turn
   * ended, or by a restarted runtime, still names it.
   */
  writeRevision(fact: TurnUsageRevision, turn: MeteringTurn | undefined): Promise<UsageRevisionWriteResult>
  current(filter?: CurrentFilter): Promise<TurnUsageRevision[]>
  /** Remembers `turn` as the latest the plane admitted on its session, across restarts. */
  recordTurn(turn: MeteringTurn): void
  /** The latest turn the plane admitted on `sessionId`, whether or not it still holds the session. */
  latestTurn(sessionId: string): string | undefined
  /** Files every message recorded under no turn, on a session `belongs` accepts, under `turn`. */
  adoptUnattributed(turn: MeteringTurn, belongs: (sessionId: string) => boolean): void
  /**
   * The latest unanswered revision of each message metered under one of
   * `sessionId`'s turns, whether the message is on that session or on one of
   * its descendants.
   */
  pending(sessionId: string): PendingUsageFact[]
  /**
   * Records the plane's answer for a revision and every earlier one of the
   * same message, and drops the answered revisions a later one supersedes.
   */
  settle(sessionId: string, result: ReportResult): void
  /** The meter's per-scope running usage, kept beside the facts and out of their payloads. */
  meterState: TurnMeterStateStore
  close(): void
}

const SCHEMA = [
  `create table if not exists usage_revisions (
    session_id text not null,
    message_id text not null,
    revision integer not null,
    turn_session_id text,
    turn_id text,
    payload_hash text not null,
    settlement text not null,
    fact_json text not null,
    delivery text not null default 'pending',
    primary key (session_id, message_id, revision)
  )`,
  "create index if not exists usage_revisions_unattributed on usage_revisions (session_id, message_id) where turn_id is null",
  "create index if not exists usage_revisions_by_turn_session on usage_revisions (turn_session_id, delivery)",
  "create index if not exists usage_revisions_by_settlement on usage_revisions (settlement)",
  `create table if not exists usage_session_turns (
    session_id text primary key,
    turn_id text not null
  )`,
  `create table if not exists usage_meter_state (
    session_id text not null,
    message_id text not null,
    streams_json text not null,
    observation_keys_json text not null,
    primary key (session_id, message_id)
  )`,
]

type LatestRow = { revision: number; payload_hash: string; turn_session_id: string | null; turn_id: string | null }
type FactRow = { session_id: string; fact_json: string }
type PendingRow = FactRow & { message_id: string; turn_id: string }

/**
 * A cloud runtime's own record of its turns' usage, and the outbox of what
 * the plane has not yet answered for, on whatever SQLite the runtime keeps:
 * a sandbox's store directory, a session host's Durable Object storage. It
 * outlives the runtime process, so a restarted runtime still reports what it
 * metered before.
 */
export function createRuntimeUsageLedger(input: { db: SqliteDatabase; workspaceId: () => string }): RuntimeUsageLedger {
  const { db } = input
  for (const statement of SCHEMA) db.exec(statement)
  const latest = db.prepare<LatestRow>(
    "select revision, payload_hash, turn_session_id, turn_id from usage_revisions where session_id = ? and message_id = ? order by revision desc limit 1",
  )
  const insert = db.prepare(`
    insert into usage_revisions (session_id, message_id, revision, turn_session_id, turn_id, payload_hash, settlement, fact_json)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const currentStatements = new Map<string, SqliteStatement<FactRow>>()
  // One statement per filter shape: SQLite plans a `? is null or column = ?`
  // predicate as a scan of the whole table.
  const currentRows = (filter: CurrentFilter) => {
    const columns = ([
      ["session_id", filter.sessionId],
      ["message_id", filter.messageId],
      ["settlement", filter.settlement],
    ] as const).flatMap(([column, value]) => (value === undefined ? [] : [[column, value] as const]))
    const shape = columns.map(([column]) => column).join(",")
    let statement = currentStatements.get(shape)
    if (!statement) {
      statement = db.prepare<FactRow>(`
        select session_id, fact_json from usage_revisions row
        where revision = (
          select max(revision) from usage_revisions message
          where message.session_id = row.session_id and message.message_id = row.message_id
        )${columns.map(([column]) => ` and row.${column} = ?`).join("")}
        order by row.rowid
      `)
      currentStatements.set(shape, statement)
    }
    return statement.all(...columns.map(([, value]) => value))
  }
  const saveTurn = db.prepare(
    "insert into usage_session_turns (session_id, turn_id) values (?, ?) on conflict (session_id) do update set turn_id = excluded.turn_id",
  )
  const loadTurn = db.prepare<{ turn_id: string }>("select turn_id from usage_session_turns where session_id = ?")
  const unattributedRows = db.prepare<{ session_id: string; message_id: string }>(
    "select distinct session_id, message_id from usage_revisions where turn_id is null",
  )
  const attribute = db.prepare(
    "update usage_revisions set turn_session_id = ?, turn_id = ? where session_id = ? and message_id = ? and turn_id is null",
  )
  const pendingRows = db.prepare<PendingRow>(`
    select session_id, message_id, turn_id, fact_json from usage_revisions row
    where turn_session_id = ? and delivery = 'pending' and revision = (
      select max(revision) from usage_revisions message
      where message.session_id = row.session_id and message.message_id = row.message_id and message.delivery = 'pending'
    )
    order by row.rowid
  `)
  const settleRows = db.prepare(
    "update usage_revisions set delivery = ? where session_id = ? and message_id = ? and revision <= ? and delivery = 'pending'",
  )
  const pruneAnswered = db.prepare(`
    delete from usage_revisions
    where session_id = ? and message_id = ? and delivery <> 'pending' and revision < (
      select max(revision) from usage_revisions where session_id = ? and message_id = ?
    )
  `)
  const loadState = db.prepare<{ streams_json: string; observation_keys_json: string }>(
    "select streams_json, observation_keys_json from usage_meter_state where session_id = ? and message_id = ?",
  )
  const saveState = db.prepare(`
    insert into usage_meter_state (session_id, message_id, streams_json, observation_keys_json) values (?, ?, ?, ?)
    on conflict (session_id, message_id) do update set
      streams_json = excluded.streams_json, observation_keys_json = excluded.observation_keys_json
  `)
  const stored = (factJson: string) => {
    try {
      return readUsageReportRevision(JSON.parse(factJson))
    } catch {
      return undefined
    }
  }
  return {
    async writeRevision(item, turn) {
      assertTurnUsageRevision(item)
      const hash = await usageRevisionHash(item)
      const current = latest.get(item.sessionId, item.messageId)
      if (current && item.revision < current.revision) return { status: "stale", currentRevision: current.revision }
      if (current && item.revision === current.revision) {
        return current.payload_hash === hash ? { status: "duplicate" } : { status: "conflict", currentRevision: current.revision }
      }
      const filedUnder = current
        ? { sessionId: current.turn_session_id, turnId: current.turn_id }
        : { sessionId: turn?.sessionId ?? null, turnId: turn?.turnId ?? null }
      insert.run(
        item.sessionId,
        item.messageId,
        item.revision,
        filedUnder.sessionId,
        filedUnder.turnId,
        hash,
        item.settlement,
        JSON.stringify(usageReportRevision(item)),
      )
      return { status: "accepted" }
    },
    async current(filter = {}) {
      return currentRows(filter).flatMap((row) => {
        const fact = stored(row.fact_json)
        return fact ? [cloudWorkspaceUsageRevision(fact, { workspaceId: input.workspaceId(), sessionId: row.session_id })] : []
      })
    },
    recordTurn(turn) {
      saveTurn.run(turn.sessionId, turn.turnId)
    },
    latestTurn(sessionId) {
      return loadTurn.get(sessionId)?.turn_id
    },
    adoptUnattributed(turn, belongs) {
      db.transaction(() => {
        for (const row of unattributedRows.all()) {
          if (belongs(row.session_id)) attribute.run(turn.sessionId, turn.turnId, row.session_id, row.message_id)
        }
      })
    },
    pending(sessionId) {
      return pendingRows.all(sessionId).flatMap((row) => {
        const fact = stored(row.fact_json)
        if (!fact) return []
        const messageId = reportedMessageId({ sessionId: row.session_id, turnSessionId: sessionId, messageId: row.message_id })
        return [{ sessionId: row.session_id, messageId: row.message_id, fact: { ...fact, messageId, turnId: row.turn_id } }]
      })
    },
    settle(sessionId, result) {
      db.transaction(() => {
        settleRows.run(DELIVERY[result.status], sessionId, result.messageId, result.revision)
        pruneAnswered.run(sessionId, result.messageId, sessionId, result.messageId)
      })
    },
    meterState: {
      async load({ sessionId, messageId }) {
        const row = loadState.get(sessionId, messageId)
        if (!row) return undefined
        try {
          return readTurnMeterState(JSON.parse(row.streams_json), JSON.parse(row.observation_keys_json))
        } catch {
          return undefined
        }
      },
      async save({ sessionId, messageId, state }) {
        saveState.run(sessionId, messageId, JSON.stringify(state.streams), JSON.stringify(state.lastObservationKeys))
      },
    },
    close() {
      db.close()
    },
  }
}
