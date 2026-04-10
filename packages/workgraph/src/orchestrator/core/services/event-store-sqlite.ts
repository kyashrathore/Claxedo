import type { EventEnvelope } from "../../events";
import { events } from "../db/schema";
import { eq, and, gt, max, desc } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { IEventStore } from "./event-store";
import type { IHashChain } from "./hash-chain";
import { openNodeHashChain } from "./hash-chain-node";
import { client, type RawDatabase, type SqliteInput } from "../../../sqlite";

// To swap SQLite drivers (e.g. bun:sqlite → better-sqlite3), update the two
// driver imports above and the Db alias. The class below is unchanged.
type Db = BetterSQLite3Database;

// ---------------------------------------------------------------------------
// SqliteEventStore — Drizzle-backed implementation of IEventStore
// ---------------------------------------------------------------------------

class SqliteEventStore implements IEventStore {
  constructor(
    private db: Db,
    private hasher: IHashChain,
  ) {}

  async append(
    partial: Omit<EventEnvelope, "stream_seq" | "logical_ts" | "prev_hash" | "hash">,
  ): Promise<EventEnvelope> {
    // 1. Compute next stream_seq (1 for the first event on a run)
    const seqResult = await this.db
      .select({ maxSeq: max(events.stream_seq) })
      .from(events)
      .where(eq(events.run_id, partial.run_id));
    const seq = (seqResult[0]?.maxSeq ?? 0) + 1;

    // 2. Get prev_hash from the most recent event on this run
    const prevResult = await this.db
      .select({ hash: events.hash })
      .from(events)
      .where(eq(events.run_id, partial.run_id))
      .orderBy(desc(events.stream_seq))
      .limit(1);
    const prevHash = prevResult[0]?.hash ?? "00000000";

    // 3. Build full envelope (hash placeholder)
    const envelope: EventEnvelope = {
      ...partial,
      stream_seq: seq,
      logical_ts: seq,
      prev_hash: prevHash,
      hash: "",
    };

    // 4. Compute real SHA-256 hash
    envelope.hash = await this.hasher.computeHash(envelope, prevHash);

    // 4a. Conflict detection: same stream_id + stream_seq but different id (concurrent writers)
    //     Resolve with last-writer-wins on created_at.
    const conflictCheck = await this.db
      .select({ id: events.id, created_at: events.created_at })
      .from(events)
      .where(and(eq(events.stream_id, partial.stream_id), eq(events.stream_seq, seq)))
      .limit(1);

    const conflict = conflictCheck[0]
    if (conflict && conflict.id !== envelope.id) {
      if (envelope.created_at > conflict.created_at) {
        // Local event is newer — replace the existing remote row
        await this.db.delete(events).where(eq(events.id, conflict.id));
      } else {
        // Remote event is newer or equal — skip this insert, return existing
        const existing = await this.db
          .select()
          .from(events)
          .where(eq(events.id, conflict.id))
          .limit(1);
        return (existing[0] ?? envelope) as EventEnvelope;
      }
    }

    // 5. Insert with idempotency on op_id
    try {
      await this.db.insert(events).values(envelope);
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE constraint")) {
        // op_id already exists — return the existing event
        const existing = await this.db
          .select()
          .from(events)
          .where(eq(events.op_id, partial.op_id))
          .limit(1);
        if (existing.length > 0) return existing[0] as EventEnvelope;
        return envelope;
      }
      throw err;
    }

    return envelope;
  }

  async getEvents(runId: string, sinceSeq?: number): Promise<EventEnvelope[]> {
    if (sinceSeq !== undefined) {
      return this.db
        .select()
        .from(events)
        .where(and(eq(events.run_id, runId), gt(events.stream_seq, sinceSeq)))
        .orderBy(events.stream_seq) as Promise<EventEnvelope[]>;
    }
    return this.db
      .select()
      .from(events)
      .where(eq(events.run_id, runId))
      .orderBy(events.stream_seq) as Promise<EventEnvelope[]>;
  }

  async replayEvents<S>(
    runId: string,
    reducer: (state: S, event: EventEnvelope) => S,
    initial: S,
  ): Promise<S> {
    const evts = await this.getEvents(runId);
    return evts.reduce((state, event) => reducer(state, event), initial);
  }

  async getAllEvents(): Promise<EventEnvelope[]> {
    return this.db
      .select()
      .from(events)
      .orderBy(events.stream_seq) as Promise<EventEnvelope[]>;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IEventStore backed by the given better-sqlite3 Database.
 * Wraps it in a Drizzle instance internally.
 *
 * Pass a custom IHashChain to swap the hashing algorithm; defaults to
 * the Node SHA-256 implementation.
 *
 * @example
 *   const sqlite = new Database(':memory:')
 *   const eventStore = openSqliteEventStore(sqlite)
 *   await eventStore.append({ ... })
 */
export function openSqliteEventStore(
  sqlite: SqliteInput,
  hasher: IHashChain = openNodeHashChain(),
): IEventStore {
  return new SqliteEventStore(drizzle(client(sqlite) as unknown as RawDatabase), hasher);
}
