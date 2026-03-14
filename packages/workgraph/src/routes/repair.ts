import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { verifyChain } from "../orchestrator/core/services/hash-chain";
import {
  verify,
  rebuild,
  replay,
  reconcile,
} from "../orchestrator/core/cli/repair";
import {
  rootReducer,
  initialRootState,
} from "../orchestrator/core/reducers/index";
import type { EventEnvelope } from "../orchestrator/events";

/**
 * Creates a Hono sub-router for repair/diagnostic APIs.
 * Handles chain verification, state rebuild, replay, and reconciliation.
 */
export function repairRouter(db: any) {
  const router = new Hono();

  // --- POST /repair/verify ---
  router.post("/repair/verify", async (c) => {
    const events = db
      .query("SELECT * FROM events ORDER BY stream_seq ASC")
      .all() as EventEnvelope[];

    const result = await verify(events, verifyChain);

    return c.json(result);
  });

  // --- POST /repair/rebuild ---
  router.post("/repair/rebuild", async (c) => {
    const events = db
      .query("SELECT * FROM events ORDER BY stream_seq ASC")
      .all() as EventEnvelope[];

    const { result, state } = await rebuild(
      events,
      rootReducer,
      { ...initialRootState }
    );

    return c.json(result);
  });

  // --- POST /repair/replay ---
  router.post("/repair/replay", async (c) => {
    const events = db
      .query("SELECT * FROM events ORDER BY stream_seq ASC")
      .all() as EventEnvelope[];

    // Rebuild current state first to use as target
    let currentState = { ...initialRootState };
    for (const event of events) {
      currentState = rootReducer(currentState, event);
    }

    const result = await replay(
      events,
      rootReducer,
      { ...initialRootState },
      currentState
    );

    return c.json(result);
  });

  // --- POST /repair/reconcile ---
  router.post(
    "/repair/reconcile",
    zValidator(
      "json",
      z.object({
        remote_events: z.array(
          z.object({
            id: z.string(),
            run_id: z.string(),
            stream_id: z.string(),
            stream_seq: z.number(),
            logical_ts: z.number(),
            schema_version: z.number(),
            type: z.string(),
            payload_json: z.string(),
            actor_type: z.string(),
            actor_id: z.string(),
            op_id: z.string(),
            prev_hash: z.string(),
            hash: z.string(),
            created_at: z.string(),
          })
        ),
      })
    ),
    async (c) => {
      const { remote_events } = c.req.valid("json");

      const localEvents = db
        .query("SELECT * FROM events ORDER BY stream_seq ASC")
        .all() as EventEnvelope[];

      const result = await reconcile(localEvents, remote_events);

      return c.json(result);
    }
  );

  return router;
}
