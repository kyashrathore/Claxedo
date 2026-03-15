import { Hono } from "hono"
import { getTraceEvents, getTraceEventsByType } from "../orchestrator/trace"
import type { TraceEventType } from "../orchestrator/trace"

export function traceRouter(db: any) {
  const router = new Hono()

  /**
   * GET /runs/:run_id/trace
   *
   * Query params:
   *   node_id  - filter to a single node
   *   types    - comma-separated list of event types to filter
   */
  router.get("/runs/:run_id/trace", (c) => {
    const runId = c.req.param("run_id")
    const nodeId = c.req.query("node_id")
    const typesParam = c.req.query("types")

    let events
    if (typesParam) {
      const types = typesParam.split(",").map((t) => t.trim()) as TraceEventType[]
      events = getTraceEventsByType(db, runId, types)
      if (nodeId) {
        events = events.filter((e) => e.node_id === nodeId)
      }
    } else {
      events = getTraceEvents(db, runId, nodeId)
    }

    return c.json({ run_id: runId, events })
  })

  return router
}
