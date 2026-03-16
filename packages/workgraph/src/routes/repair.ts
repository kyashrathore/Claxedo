import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { verifyChain } from "../orchestrator/core/services/hash-chain-node";
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
import type { IEventStore } from "../orchestrator/core/services/event-store";

/**
 * Creates a Hono sub-router for repair/diagnostic APIs.
 * Handles chain verification, state rebuild, replay, and reconciliation.
 */
export function repairRouter(eventStore: IEventStore) {
  const router = new Hono();

  // --- POST /repair/verify ---
  router.post("/repair/verify", async (c) => {
    const events = await eventStore.getAllEvents();
    return c.json(await verify(events, verifyChain));
  });

  // --- POST /repair/rebuild ---
  router.post("/repair/rebuild", async (c) => {
    const events = await eventStore.getAllEvents();
    const { result } = await rebuild(events, rootReducer, { ...initialRootState });
    return c.json(result);
  });

  // --- POST /repair/replay ---
  router.post("/repair/replay", async (c) => {
    const events = await eventStore.getAllEvents();
    const targetState = await eventStore.replayEvents("*", rootReducer, { ...initialRootState });
    // Rebuild by folding all events (stream_id ignored for global replay)
    let currentState = { ...initialRootState };
    for (const event of events) currentState = rootReducer(currentState, event);
    return c.json(await replay(events, rootReducer, { ...initialRootState }, currentState));
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
      const localEvents = await eventStore.getAllEvents();
      return c.json(await reconcile(localEvents, remote_events));
    }
  );

  return router;
}
