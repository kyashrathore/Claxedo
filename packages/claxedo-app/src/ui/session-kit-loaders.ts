import type { FileDiffMetadata } from "@opencode-ai/session-ui/session-diff"
import { ensureOpenCodeTheme } from "@opencode-ai/ui/context/marked"

export async function loadFileComponent() {
  const [module] = await Promise.all([import("@opencode-ai/session-ui/file"), ensureOpenCodeTheme()])
  return module.File
}

/**
 * Lazy edge for the session-ui Markdown renderer. markdown.tsx statically pulls
 * shiki (`bundledLanguages`) plus the highlight worker, so an eager surface that
 * needs Markdown must cross this dynamic boundary instead of importing
 * `@/ui/session-kit` (see session-context-tab.tsx).
 */
export async function loadMarkdownComponent() {
  const [module] = await Promise.all([import("@opencode-ai/session-ui/markdown"), ensureOpenCodeTheme()])
  return module.Markdown
}

let markdownPrewarmStarted = false

/**
 * Idle-time warm-up for the Markdown/highlight stack. Without it, the first
 * session switch pays the markdown chunk's module evaluation (marked + shiki's
 * `bundledLanguages` + the highlight worker URL) and the @pierre/diffs theme
 * registration inside the switch window (observed as ~35ms of `markdown.parse`
 * warm-up). Loading stays behind a dynamic import so the forbidden-eager-deps
 * guard is unaffected — call this only from an idle callback after boot.
 */
export function prewarmMarkdownStack() {
  if (markdownPrewarmStarted) return
  markdownPrewarmStarted = true
  void loadMarkdownComponent().catch(() => {
    // Network hiccup: allow a later idle callback (or the real first render)
    // to retry the import.
    markdownPrewarmStarted = false
  })
}

/**
 * Warm the Markdown/highlight stack once boot settles instead of paying its
 * chunk evaluation (marked + shiki + @pierre/diffs theme) inside the first
 * session switch. requestIdleCallback keeps it strictly off the boot critical
 * path; environments without it (test DOMs) skip the warmup and load lazily on
 * first render, exactly as before. Returns a disposer for onCleanup.
 */
export function scheduleMarkdownPrewarm(): () => void {
  if (typeof requestIdleCallback !== "function") return () => {}
  const idle = requestIdleCallback(() => prewarmMarkdownStack())
  return () => cancelIdleCallback(idle)
}

/**
 * Warm the diff highlighter's worker pool for one diff style.
 *
 * `getWorkerPool` (session-ui/pierre/worker) builds its shiki workers, and
 * those workers load the wasm highlighter, on the FIRST diff that renders in
 * that style. That put a worker boot plus a multi-hundred-kilobyte wasm load
 * inside the click that expands a review diff. Warming it while the review
 * corpus is already on screen and the surface is idle moves that cost off the
 * interaction and changes nothing about what is rendered.
 *
 * Dynamic import for the same reason as the loaders above: this is an edge
 * into @pierre/diffs and must never become an eager one. Calling it repeatedly
 * is free: the module import is cached and `getWorkerPool` returns the pool it
 * already built for that style.
 */
export function warmDiffHighlightWorkerPool(style: "unified" | "split") {
  if (typeof window === "undefined") return
  void import("@opencode-ai/session-ui/pierre/worker")
    .then((module) => void module.getWorkerPool(style))
    // Network hiccup: let the real first render build the pool instead.
    .catch(() => {})
}

/**
 * Highlight one diff in the worker pool BEFORE anything renders it.
 *
 * A diff that mounts with no highlight in the pool's cache renders three
 * times: the renderer builds a plain AST on the main thread (word-level
 * intra-line diffing included), applies it to the shadow tree, and then
 * replaces every row again when the worker's highlighted result arrives —
 * the second application landing after the interaction has already been
 * acknowledged, as visible re-render and scroll-correction jank.
 *
 * Priming is that same worker request, issued while the pointer is only
 * resting on the row. `primeDiffHighlightCache` is instance-free: it fills the
 * pool's diff LRU (bounded, `totalASTLRUCacheSize`, 100 by default) and
 * notifies nobody, so it cannot render anything early. When the row is then
 * expanded, `DiffHunksRenderer` finds the highlighted result in that cache and
 * mounts already-highlighted rows in ONE render — no main-thread plain pass,
 * no late replacement.
 *
 * It needs `fileDiff.cacheKey`, which `resolveFileDiff` stamps from the diff's
 * content; a diff whose content changed resolves to a different key and misses
 * cleanly rather than reusing the old highlight.
 *
 * Dynamic import for the same reason as `warmDiffHighlightWorkerPool`: the
 * edge into @pierre/diffs must never become an eager one. Priming a diff the
 * pool already holds is free — `primeDiffHighlightCache` returns early on a
 * cache hit or an in-flight request for the same key.
 */
export function primeDiffHighlight(style: "unified" | "split", fileDiff: FileDiffMetadata) {
  if (typeof window === "undefined") return
  void import("@opencode-ai/session-ui/pierre/worker")
    .then((module) => module.getWorkerPool(style)?.primeDiffHighlightCache(fileDiff))
    // Network hiccup: the expand still renders, just without the head start.
    .catch(() => {})
}
