import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  hydrateFeatureSlice,
  type ConnectorInterface,
} from "../orchestrator/core/services/hydration";
import {
  rootReducer,
  initialRootState,
} from "../orchestrator/core/reducers/index";
import type { IEventStore } from "../orchestrator/core/services/event-store";

/**
 * Creates a Hono sub-router for hydration APIs.
 * Handles feature hydration and state rebuild.
 */
export function hydrationRouter(eventStore: IEventStore) {
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

  // --- GET /features/:feature_id/pull ---
  router.get("/features/:feature_id/pull", async (c) => {
    const featureId = c.req.param("feature_id");
    const state = await eventStore.replayEvents(featureId, rootReducer, { ...initialRootState });
    const events = await eventStore.getEvents(featureId);
    if (!events.length) {
      return c.json({ feature_id: featureId, state: null, events: 0 });
    }
    return c.json({ feature_id: featureId, state, events: events.length });
  });

  // --- POST /sync/rebuild ---
  router.post("/sync/rebuild", async (c) => {
    const allEvents = await eventStore.getAllEvents();
    let state = { ...initialRootState };
    for (const event of allEvents) state = rootReducer(state, event);
    return c.json({ success: true, eventsProcessed: allEvents.length });
  });

  return router;
}
