import type { Context } from "hono"

/**
 * Background work that must outlive the response.
 *
 * On Cloudflare Workers, `executionCtx.waitUntil` is the only thing that keeps
 * the isolate alive after the response returns; a detached promise is
 * cancelled with the request. On Node `executionCtx` throws, and a detached
 * promise simply keeps running. Every route that starts work past its
 * response goes through here so that difference lives in one place.
 */
export type BackgroundScheduler = (work: Promise<unknown>) => void

/**
 * The Worker scheduler when one exists, `undefined` on Node. For work that is
 * only meaningful on the Worker plane (a caller that wants "skip on Node"
 * rather than "run detached on Node").
 */
export function guardedWaitUntil(c: Context): BackgroundScheduler | undefined {
  try {
    const ctx = c.executionCtx
    if (typeof ctx?.waitUntil !== "function") return undefined
    return (work) => ctx.waitUntil(work)
  } catch {
    return undefined
  }
}

/**
 * Keeps `work` alive past the response on Workers and lets it run detached on
 * Node. `work` must settle its own rejections: nothing here observes them.
 */
export function keepAlivePastResponse(c: Context, work: Promise<unknown>): void {
  const schedule = guardedWaitUntil(c)
  if (schedule) schedule(work)
  else void work
}
