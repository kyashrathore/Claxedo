import type { WorkGraphReconcileResult } from "../routes/hosted-workgraph-admin"

/**
 * The bounded reconciler is not written for parallel runs: overlapping runs in
 * one isolate contend on the same durable work and have hung the Workers
 * runtime outright (staging run 29514161976, "code had hung and would never
 * generate a response"). Serialize per isolate by SKIPPING an overlapping
 * trigger — never queueing or sharing the in-flight promise across request
 * contexts, which the Workers I/O model forbids. Callers poll (cron, smoke
 * cycles), so a skipped run is retried naturally by the next trigger.
 */
export function skipOverlappingReconcile(
  reconcile: () => Promise<WorkGraphReconcileResult>,
): () => Promise<WorkGraphReconcileResult> {
  let running = false
  return async () => {
    if (running) return { launched: [], results: [], skipped: true }
    running = true
    try {
      return await reconcile()
    } finally {
      running = false
    }
  }
}
