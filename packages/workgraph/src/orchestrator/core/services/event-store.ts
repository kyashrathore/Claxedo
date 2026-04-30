import type { EventEnvelope } from "../../events";

/**
 * Adapter-agnostic interface for event-store persistence.
 *
 * To swap the storage backend, implement this interface and pass the new
 * implementation wherever IEventStore is required. The current implementation
 * is SqliteEventStore in event-store-sqlite.ts.
 */
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
  /** Return all events across all runs, ordered by stream_seq. Used for repair/rebuild. */
  getAllEvents(): Promise<EventEnvelope[]>;
}
