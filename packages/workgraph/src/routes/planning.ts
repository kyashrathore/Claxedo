import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { PlanningService } from "../orchestrator/core/services/planning";
import type { PlanResult } from "../orchestrator/core/services/planning";

/**
 * Creates a Hono sub-router for planning APIs.
 * Stores plans in-memory keyed by run_id.
 */
export function planningRouter(service?: PlanningService) {
  const planning = service ?? new PlanningService();
  const plans = new Map<string, PlanResult>();
  const router = new Hono();

  // --- POST /runs/:run_id/plan ---
  router.post(
    "/runs/:run_id/plan",
    zValidator(
      "json",
      z.object({
        goal: z.string().min(1),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const { goal } = c.req.valid("json");

      const plan = planning.plan(runId, goal);
      plans.set(runId, plan);

      return c.json(plan, 201);
    }
  );

  // --- GET /runs/:run_id/plan ---
  router.get("/runs/:run_id/plan", async (c) => {
    const runId = c.req.param("run_id");
    const plan = plans.get(runId);

    if (!plan) {
      return c.json({ error: "No plan found for this run" }, 404);
    }

    return c.json(plan);
  });

  // --- POST /runs/:run_id/routes/preview ---
  router.post(
    "/runs/:run_id/routes/preview",
    zValidator(
      "json",
      z.object({
        goal: z.string().min(1),
        capabilities: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
          })
        ),
      })
    ),
    async (c) => {
      const { goal, capabilities } = c.req.valid("json");

      // Simple scoring based on keyword overlap
      const scores = capabilities.map((cap) => {
        const goalLower = goal.toLowerCase();
        const descLower = cap.description.toLowerCase();
        const words = goalLower.split(/\s+/);
        const matchCount = words.filter((w) => descLower.includes(w)).length;
        const confidence = Math.min(matchCount / Math.max(words.length, 1), 1);
        return { id: cap.id, confidence };
      });

      scores.sort((a, b) => b.confidence - a.confidence);
      return c.json(scores);
    }
  );

  // --- POST /runs/:run_id/dispatch ---
  router.post("/runs/:run_id/dispatch", async (c) => {
    const runId = c.req.param("run_id");
    const plan = plans.get(runId);

    if (!plan) {
      return c.json({ error: "No plan found for this run" }, 404);
    }

    const dispatched = planning.dispatch(plan);
    return c.json(dispatched);
  });

  return router;
}
