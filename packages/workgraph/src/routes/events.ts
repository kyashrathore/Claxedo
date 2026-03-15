import { Hono } from "hono";
import { stream } from "hono/streaming";

/**
 * Creates a Hono sub-router for event-related APIs.
 * The DB is passed via closure.
 */
export function eventsRouter(db: any) {
  const router = new Hono();

  // --- GET /runs/:run_id/events ---
  router.get("/runs/:run_id/events", async (c) => {
    const runId = c.req.param("run_id");
    const sinceSeq = c.req.query("since_seq");

    let rows: any[];
    if (sinceSeq) {
      const seq = parseInt(sinceSeq, 10);
      rows = db
        .query(
          "SELECT * FROM events WHERE run_id = ? AND stream_seq > ? ORDER BY stream_seq ASC"
        )
        .all(runId, seq);
    } else {
      rows = db
        .query(
          "SELECT * FROM events WHERE run_id = ? ORDER BY stream_seq ASC"
        )
        .all(runId);
    }

    return c.json(rows);
  });

  // --- GET /runs/:run_id/events/stream ---
  router.get("/runs/:run_id/events/stream", async (c) => {
    const runId = c.req.param("run_id");

    const rows = db
      .query(
        "SELECT * FROM events WHERE run_id = ? ORDER BY stream_seq ASC"
      )
      .all(runId) as any[];

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      for (const event of rows) {
        await s.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // In v1, no live streaming - just close after sending existing events
    });
  });

  return router;
}
