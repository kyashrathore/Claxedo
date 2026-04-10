import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { ITriggerStore } from "../triggers/trigger-store";
import type { IRunStore } from "../sdk/runs";
import type { IEventStore } from "../orchestrator/core/services/event-store";
import type { IExecutionStore } from "../sdk/execution-store";
import { fireTrigger } from "../triggers/scheduler";

const CreateSchema = z.object({
  title: z.string().min(1),
  schedule: z.string().min(1),
  enabled: z.boolean().optional(),
  runtime_type_hint: z.enum(["workspace", "task", "service"]).optional(),
  template_id: z.string().optional(),
  fanout_mode: z.enum(["single", "fanout"]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  runtime_type_hint: z.enum(["workspace", "task", "service"]).optional(),
  template_id: z.string().optional(),
  fanout_mode: z.enum(["single", "fanout"]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export function triggersRouter(
  triggerStore: ITriggerStore,
  runStore: IRunStore,
  eventStore: IEventStore,
  executionStore: IExecutionStore,
) {
  const router = new Hono();

  // GET /triggers — list all triggers
  router.get("/triggers", (c) => {
    return c.json(triggerStore.list());
  });

  // POST /triggers — create a trigger
  router.post("/triggers", zValidator("json", CreateSchema), (c) => {
    const input = c.req.valid("json");
    const trigger = triggerStore.create(input);
    return c.json(trigger, 201);
  });

  // GET /triggers/:id — get a single trigger
  router.get("/triggers/:id", (c) => {
    const id = c.req.param("id");
    const trigger = triggerStore.get(id);
    if (!trigger) return c.json({ error: "Trigger not found" }, 404);
    return c.json(trigger);
  });

  // PATCH /triggers/:id — update a trigger
  router.patch("/triggers/:id", zValidator("json", UpdateSchema), (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const trigger = triggerStore.update(id, input);
      return c.json(trigger);
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // DELETE /triggers/:id — delete a trigger
  router.delete("/triggers/:id", (c) => {
    const id = c.req.param("id");
    try {
      triggerStore.delete(id);
      return c.json({ deleted: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // POST /triggers/:id/fire — manually fire a trigger (also used by Inngest cron callback)
  router.post("/triggers/:id/fire", async (c) => {
    const id = c.req.param("id");
    try {
      const results = await fireTrigger(triggerStore, runStore, eventStore, executionStore, id);
      return c.json({ fired: true, runs: results }, 201);
    } catch (err: any) {
      const status = err.message.includes("not found") ? 404 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  // GET /triggers/:id/runs — list runs spawned by this trigger
  router.get("/triggers/:id/runs", (c) => {
    const id = c.req.param("id");
    const trigger = triggerStore.get(id);
    if (!trigger) return c.json({ error: "Trigger not found" }, 404);
    return c.json(triggerStore.listRunsByTrigger(id));
  });

  return router;
}
