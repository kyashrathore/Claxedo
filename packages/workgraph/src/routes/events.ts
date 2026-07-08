import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { IEventStore } from "../substrate/event-store";

export function eventsRouter(eventStore: IEventStore) {
  const router = new Hono();

  router.get("/runs/:run_id/events", async (c) => {
    const runId = c.req.param("run_id");
    const sinceSeq = c.req.query("since_seq");
    const events = await eventStore.getEvents(runId, sinceSeq ? parseInt(sinceSeq, 10) : undefined);
    return c.json(events);
  });

  router.get("/runs/:run_id/events/stream", async (c) => {
    const runId = c.req.param("run_id");
    const events = await eventStore.getEvents(runId);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      for (const event of events) {
        await s.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
  });

  return router;
}
