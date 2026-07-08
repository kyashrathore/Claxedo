import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ulid } from "ulid";
import { ScratchpadService } from "../substrate/scratchpad";

/**
 * Creates a Hono sub-router for scratchpad APIs.
 * Uses an in-memory ScratchpadService instance.
 */
export function scratchpadRouter(service?: ScratchpadService) {
  const scratchpad = service ?? new ScratchpadService();
  const router = new Hono();

  // --- POST /runs/:run_id/scratchpad ---
  router.post(
    "/runs/:run_id/scratchpad",
    zValidator(
      "json",
      z.object({
        node_id: z.string().min(1),
        content: z.string().min(1),
      })
    ),
    async (c) => {
      const runId = c.req.param("run_id");
      const { node_id, content } = c.req.valid("json");

      const entryId = `sp_${ulid()}`;

      try {
        const entry = scratchpad.write(runId, node_id, entryId, content);
        return c.json(entry, 201);
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    }
  );

  // --- GET /runs/:run_id/scratchpad ---
  router.get("/runs/:run_id/scratchpad", async (c) => {
    const runId = c.req.param("run_id");
    const entries = scratchpad.read(runId);
    return c.json(entries);
  });

  // --- POST /runs/:run_id/scratchpad/:entry_id/promote ---
  router.post("/runs/:run_id/scratchpad/:entry_id/promote", async (c) => {
    const entryId = c.req.param("entry_id");

    const result = scratchpad.promote(entryId);
    if (!result) {
      return c.json({ error: "Entry not found" }, 404);
    }

    return c.json(result);
  });

  return router;
}
