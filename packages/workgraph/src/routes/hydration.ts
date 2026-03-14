import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  hydrateFeatureSlice,
  type ConnectorInterface,
} from "../orchestrator/core/services/hydration";
import { SyncEngine } from "../orchestrator/sync/sync";
import {
  rootReducer,
  initialRootState,
} from "../orchestrator/core/reducers/index";
import type { EventEnvelope } from "../orchestrator/events";

/**
 * Creates a Hono sub-router for hydration and sync APIs.
 * Handles feature hydration, sync push/pull, status, and rebuild.
 */
export function hydrationRouter(db: any) {
  const syncEngine = new SyncEngine();
  const router = new Hono();

  // --- POST /features/hydrate ---
  router.post(
    "/features/hydrate",
    zValidator(
      "json",
      z.object({
        provider: z.string().min(1),
        feature_id: z.string().min(1),
        issue_params: z.array(z.record(z.string(), z.any())),
      })
    ),
    async (c) => {
      const { provider, feature_id, issue_params } = c.req.valid("json");

      // Create a mock connector
      const connector: ConnectorInterface = {
        provider,
        async hydrateIssue(params: Record<string, any>) {
          return {
            id: params.id ?? `issue_${Date.now()}`,
            title: params.title ?? "Untitled",
            description: params.description ?? "",
            status: params.status ?? "open",
            provider_url: params.url ?? `https://${provider}.example.com/issues/${params.id ?? "unknown"}`,
          };
        },
      };

      const slice = await hydrateFeatureSlice(connector, feature_id, issue_params);

      return c.json(slice, 201);
    }
  );

  // --- POST /features/:feature_id/push ---
  router.post("/features/:feature_id/push", async (c) => {
    const featureId = c.req.param("feature_id");

    // Load events for the feature from the sync outbox if available,
    // otherwise load from events table
    const events = db
      .query("SELECT * FROM events WHERE stream_id = ? ORDER BY stream_seq ASC")
      .all(featureId) as EventEnvelope[];

    // Push events to the sync engine buffer
    for (const event of events) {
      syncEngine.push(event);
    }

    // Flush with a no-op handler (simulates successful push)
    const pending = syncEngine.getPendingCount();
    await syncEngine.flush(async () => true);

    return c.json({ pushed: pending });
  });

  // --- GET /features/:feature_id/pull ---
  router.get("/features/:feature_id/pull", async (c) => {
    const featureId = c.req.param("feature_id");

    // Get all events for this feature and rebuild state
    const events = db
      .query("SELECT * FROM events WHERE stream_id = ? ORDER BY stream_seq ASC")
      .all(featureId) as EventEnvelope[];

    if (events.length === 0) {
      return c.json({ feature_id: featureId, state: null, events: 0 });
    }

    // Replay through rootReducer to get current state
    let state = { ...initialRootState };
    for (const event of events) {
      state = rootReducer(state, event);
    }

    return c.json({
      feature_id: featureId,
      state,
      events: events.length,
    });
  });

  // --- GET /sync/status ---
  router.get("/sync/status", async (c) => {
    return c.json({
      pending: syncEngine.getPendingCount(),
      cursor: syncEngine.getCursor(),
      backoffMs: syncEngine.getBackoffMs(),
    });
  });

  // --- POST /sync/rebuild ---
  router.post("/sync/rebuild", async (c) => {
    // Load all events and replay through rootReducer
    const events = db
      .query("SELECT * FROM events ORDER BY stream_seq ASC")
      .all() as EventEnvelope[];

    let state = { ...initialRootState };
    for (const event of events) {
      state = rootReducer(state, event);
    }

    return c.json({
      success: true,
      eventsProcessed: events.length,
    });
  });

  return router;
}
