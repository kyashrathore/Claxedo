import { z } from "zod";

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
