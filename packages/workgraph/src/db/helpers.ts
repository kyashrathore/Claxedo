import type { EventEnvelope } from "../orchestrator/events";

/**
 * Generate a random hash stub.
 * TODO: hash payload + previous hash for real chain integrity.
 */
export const generateHash = () => Math.random().toString(36).substring(2, 15);

/**
 * Insert an event into the events table.
 */
export function insertEvent(db: any, event: EventEnvelope) {
  db.run(
    `INSERT INTO events (id, run_id, stream_id, stream_seq, logical_ts, schema_version, type, payload_json, actor_type, actor_id, op_id, prev_hash, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.run_id,
      event.stream_id,
      event.stream_seq,
      event.logical_ts,
      event.schema_version,
      event.type,
      event.payload_json,
      event.actor_type,
      event.actor_id,
      event.op_id,
      event.prev_hash,
      event.hash,
      event.created_at,
    ]
  );
}

/**
 * Get the next stream_seq for a given run_id.
 */
export function getNextSeq(db: any, runId: string): number {
  const row = db
    .query("SELECT MAX(stream_seq) as max_seq FROM events WHERE run_id = ?")
    .get(runId) as { max_seq: number | null } | null;
  return (row?.max_seq ?? 0) + 1;
}
