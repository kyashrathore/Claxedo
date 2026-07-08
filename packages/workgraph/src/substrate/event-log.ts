import { z } from "zod";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * The append-only event log — the substrate's source of truth. Every state
 * change (human or agent) is an EventEnvelope; projections are derived.
 */
export const EventEnvelopeSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  stream_id: z.string(),
  stream_seq: z.number().int().nonnegative(),
  logical_ts: z.number().int().nonnegative(),
  schema_version: z.number().int().positive(),
  type: z.string(),
  payload_json: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  op_id: z.string(),
  prev_hash: z.string(),
  hash: z.string(),
  created_at: z.string().datetime(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  stream_id: text("stream_id").notNull(),
  stream_seq: integer("stream_seq").notNull(),
  logical_ts: integer("logical_ts").notNull(),
  schema_version: integer("schema_version").notNull(),
  type: text("type").notNull(),
  payload_json: text("payload_json").notNull(),
  actor_type: text("actor_type").notNull(),
  actor_id: text("actor_id").notNull(),
  op_id: text("op_id").notNull().unique(),
  prev_hash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  created_at: text("created_at").notNull(),
});
