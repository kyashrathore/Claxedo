import type { EventEnvelope } from "../../events";
import { events } from "../db/schema";
import { eq, and, gt, max, desc } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import { computeHash } from "./hash-chain";

// ---------------------------------------------------------------------------
// IEventStore — adapter-agnostic interface
// ---------------------------------------------------------------------------

export interface IEventStore {
  /** Append a new event. Computes stream_seq, prev_hash, and hash automatically. */
  append(
    partial: Omit<EventEnvelope, "stream_seq" | "logical_ts" | "prev_hash" | "hash">,
  ): Promise<EventEnvelope>;
  /** Return all events for a run, ordered by stream_seq. */
  getEvents(runId: string, sinceSeq?: number): Promise<EventEnvelope[]>;
  /** Fold all events through a reducer, returning the final state. */
  replayEvents<S>(
    runId: string,
    reducer: (state: S, event: EventEnvelope) => S,
    initial: S,
  ): Promise<S>;
}

// ---------------------------------------------------------------------------
// SqliteEventStore — Drizzle-backed implementation
// ---------------------------------------------------------------------------

class SqliteEventStore implements IEventStore {
  constructor(private db: BunSQLiteDatabase) {}

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
    envelope.hash = await computeHash(envelope, prevHash);

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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IEventStore backed by the given bun:sqlite Database.
 * Wraps it in a Drizzle instance internally.
 *
 * @example
 *   const sqlite = new Database(':memory:')
 *   const eventStore = openSqliteEventStore(sqlite)
 *   await eventStore.append({ ... })
 */
export function openSqliteEventStore(sqlite: Database): IEventStore {
  return new SqliteEventStore(drizzle(sqlite));
}
