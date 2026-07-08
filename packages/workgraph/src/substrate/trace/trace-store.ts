import { z } from "zod";
import { ulid } from "ulid";
import type { TraceEventType } from "./trace-event-types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TraceEventSchema = z.object({
  /** Unique event ID — globally unique, never reused. */
  id: z.string(),
  /** Discriminated event type from the TRACE_EVENT_TYPES enum. */
  event_type: z.string() as z.ZodType<TraceEventType>,
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: z.string().datetime(),
  /** The run this trace event belongs to. */
  run_id: z.string(),
  /** Optional: the node associated with this event (for node-scoped events). */
  node_id: z.string().optional(),
  /** Arbitrary structured payload — flexible JSON. Never mutated after append. */
  payload: z.record(z.string(), z.unknown()),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** Input for creating a new trace event — id and timestamp are auto-generated. */
export type TraceEventInput = Omit<TraceEvent, "id" | "timestamp"> & {
  timestamp?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-formed TraceEvent, generating a unique id and ISO timestamp.
 * Use this before calling appendTraceEvent so callers never touch raw fields.
 */
export function createTraceEvent(input: TraceEventInput): TraceEvent {
  return {
    id: `tev_${ulid()}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    event_type: input.event_type,
    run_id: input.run_id,
    node_id: input.node_id,
    payload: input.payload,
  };
}

// ---------------------------------------------------------------------------
// Storage — append-only; events are never updated or deleted
// ---------------------------------------------------------------------------

/**
 * Append a trace event to the database.
 * Silently ignores duplicate ids (idempotent insert).
 */
export function appendTraceEvent(db: any, event: TraceEvent): void {
  try {
    db.run(
      `INSERT INTO trace_events (id, event_type, timestamp, run_id, node_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.event_type,
        event.timestamp,
        event.run_id,
        event.node_id ?? null,
        JSON.stringify(event.payload),
      ]
    );
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE constraint")) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve all trace events for a run, ordered by insertion order (append order).
 * Optionally filter to a specific node.
 */
export function getTraceEvents(
  db: any,
  runId: string,
  nodeId?: string
): TraceEvent[] {
  let rows: any[];
  if (nodeId !== undefined) {
    rows = db
      .query(
        "SELECT * FROM trace_events WHERE run_id = ? AND node_id = ? ORDER BY rowid ASC"
      )
      .all(runId, nodeId);
  } else {
    rows = db
      .query(
        "SELECT * FROM trace_events WHERE run_id = ? ORDER BY rowid ASC"
      )
      .all(runId);
  }
  return rows.map(rowToTraceEvent);
}

/**
 * Retrieve trace events for a run filtered by one or more event types.
 */
export function getTraceEventsByType(
  db: any,
  runId: string,
  eventTypes: TraceEventType[]
): TraceEvent[] {
  if (eventTypes.length === 0) return [];
  const placeholders = eventTypes.map(() => "?").join(", ");
  const rows: any[] = db
    .query(
      `SELECT * FROM trace_events WHERE run_id = ? AND event_type IN (${placeholders}) ORDER BY rowid ASC`
    )
    .all(runId, ...eventTypes);
  return rows.map(rowToTraceEvent);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToTraceEvent(row: any): TraceEvent {
  return {
    id: row.id,
    event_type: row.event_type as TraceEventType,
    timestamp: row.timestamp,
    run_id: row.run_id,
    node_id: row.node_id ?? undefined,
    payload: JSON.parse(row.payload_json),
  };
}
