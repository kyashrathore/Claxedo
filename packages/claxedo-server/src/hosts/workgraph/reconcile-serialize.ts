import type { WorkGraphReconcileResult } from "../../routes/hosted/workgraph-admin"

/**
 * The bounded reconciler is not written for parallel runs: overlapping runs
 * contend on the same durable work and have hung the Workers runtime outright
 * (staging run 29514161976, "code had hung and would never generate a
 * response"). Serialize by SKIPPING an overlapping trigger — never queueing or
 * sharing the in-flight promise across request contexts, which the Workers I/O
 * model forbids. Callers poll (cron, smoke cycles), so a skipped run is retried
 * naturally by the next trigger.
 *
 * ## The per-isolate guard was never sufficient
 *
 * `running` below is a closure variable, and the closure lives in `worker.ts`'s
 * memoized `buildApp`. That memo is PER ISOLATE. Cloudflare runs many isolates
 * and gives no control over how many, so isolate B's `running` is false while
 * isolate A is mid-reconcile — and cron, the admin route, and smoke cycles can
 * each be served by a fresh isolate. The guard was real; its scope was one
 * isolate, which is not the scope of the hazard.
 *
 * `leaseFencedReconcile` closes that with a centrally-held lease.
 * The two layers compose deliberately and are NOT
 * redundant:
 *
 *   - the local flag is free and catches the common same-isolate overlap
 *     without a network round trip;
 *   - the lease catches the cross-isolate case the flag cannot see.
 *
 * Local first, so a same-isolate overlap never spends a store call.
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

/**
 * The cross-isolate half: a short-TTL lease with takeover.
 *
 * TTL and takeover are mandatory rather than a refinement, because the
 * motivating incident is a HANG. A lease that could not expire would convert one
 * hung holder into a reconciler that never runs again — strictly worse than the
 * overlap it prevents, since an overlap eventually makes progress and a
 * permanent stall never does. The lease documents the fence and the
 * expiry rules; this wrapper only has to release what it acquires.
 *
 * A refused acquisition returns `skipped: true`, the SAME shape as the local
 * guard, so every caller (cron, admin route, smoke cycle) already handles it and
 * nothing downstream learns that a lease exists.
 */
export type CronLease = {
  acquire: (input: { name: string; holder: string }) => Promise<
    { acquired: true; fence: number } | { acquired: false }
  >
  release: (input: { name: string; holder: string; fence: number }) => Promise<unknown>
}

export const WORKGRAPH_RECONCILE_LEASE = "workgraph_reconcile"

export function leaseFencedReconcile(input: {
  reconcile: () => Promise<WorkGraphReconcileResult>
  lease: CronLease
  /** Identifies this isolate/invocation. Opaque to the lease. */
  holder: string
  name?: string
}): () => Promise<WorkGraphReconcileResult> {
  const name = input.name ?? WORKGRAPH_RECONCILE_LEASE
  return async () => {
    const claim = await input.lease.acquire({ name, holder: input.holder })
    if (!claim.acquired) return { launched: [], results: [], skipped: true }
    try {
      return await input.reconcile()
    } finally {
      // Release so the NEXT tick starts immediately instead of waiting out the
      // TTL. Fence-checked on the store side, so a release from a holder whose
      // lease was already taken over is a no-op rather than a way to free the
      // current holder's claim.
      //
      // A failed release is deliberately swallowed: the lease expires on its
      // own, so the worst case is a few skipped ticks, and throwing here would
      // turn a successful reconcile into a reported cron failure.
      await input.lease.release({ name, holder: input.holder, fence: claim.fence }).catch(() => {})
    }
  }
}
