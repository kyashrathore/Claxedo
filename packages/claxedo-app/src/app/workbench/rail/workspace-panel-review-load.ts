import { lazy } from "solid-js"

/**
 * The workspace panel body's lazily loaded Review surface, and the one place
 * that warms it.
 *
 * Why the `lazy()` edge lives here rather than at its mount site in
 * workspace-panel-body.tsx: a warm-up only helps the wrapper it warmed.
 * Solid's `lazy()` caches the resolved module *on the wrapper*, and its first
 * render reads that cache — a second `lazy(() => import(same-specifier))`
 * around the same module would suspend again on its own first render even with
 * the chunk already in the browser's module map. One wrapper, one warm-up, one
 * owner, so the mounted surface and the warm-up can never disagree.
 *
 * What warming buys, measured on the 500-file corpus (probe resource list,
 * click-relative): without it the panel's four cold chunks — review-workspace,
 * select-file, role-guarded-terminal and time, the static-import closure Vite
 * attaches to this one dynamic edge — start only when the shell settle gate
 * opens construction at about click+100ms, and the open path then waits a
 * further ~74ms for them. Started at the click instead, they overlap the
 * shell's 120ms opening motion, which is otherwise idle but for the review
 * corpus fetch.
 */
export const ReviewWorkspace = lazy(() =>
  import("@/app/workbench/review/review-workspace").then((module) => ({ default: module.ReviewWorkspace })),
)

let warming: Promise<unknown> | undefined

/**
 * Start loading the panel body's Review surface. Idempotent and safe to call
 * from any number of intents (app idle after boot, the opening click): the
 * first call owns the request and every later one joins it, so a warm-up can
 * never turn into a second fetch inside a measured interaction.
 *
 * Rejection is swallowed: this is an optimization, and the mount site's own
 * Suspense boundary remains the surface that reports a genuinely failed load.
 */
export function warmWorkspacePanelReview() {
  warming ??= Promise.resolve(ReviewWorkspace.preload()).catch(() => undefined)
  return warming
}

/**
 * Deadline for the boot warm-up's idle slice. Long enough that a busy boot
 * keeps the thread for its own first paint; short enough that the warm-up is
 * finished before a user who reaches for the panel toggle gets there.
 */
const WARM_IDLE_TIMEOUT_MS = 1_200

/**
 * Warm the panel body once the thread is free after boot, so the common open
 * pays no module cost at all. Returns a disposer for the caller's `onCleanup`.
 *
 * Idle, not eager: the graph is the panel's, not the app shell's, and boot's
 * own chunks must claim the connection first. Where the host has no idle
 * scheduler the warm-up simply does not happen at boot — the opening click's
 * own call to `warmWorkspacePanelReview` still overlaps it with the shell
 * motion, which is the guarantee that does not depend on timing.
 */
export function warmWorkspacePanelReviewWhenIdle() {
  if (typeof requestIdleCallback !== "function") return () => {}
  const idle = requestIdleCallback(() => void warmWorkspacePanelReview(), { timeout: WARM_IDLE_TIMEOUT_MS })
  return () => {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
  }
}
