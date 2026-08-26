import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { changedLineCount, exceedsDiffLimit, hasDiffContent, type ReviewDiffShape } from "./review-session-logic"
import { mediaKindFromPath, resolveFileDiff } from "@/ui/session-kit"
import { primeDiffHighlight } from "@/ui/session-kit-loaders"

/** Distinct (style, content) prime requests remembered before the record resets. */
const PRIMED_KEY_LIMIT = 128

/**
 * Leading rows kept primed ahead of any press.
 *
 * Expand All materializes only the rows that fit the first fold — after every
 * row is projected expanded-tall that is the first one or two — and a
 * first-fold row is also the likeliest target of a single expand. Neither
 * press has a hover dwell on the row it mounts (Expand All is one button;
 * a quick click outruns the pointer-rest intent), so without this the row
 * mounts unprimed and pays the plain-AST-then-replace passes that stretch the
 * interaction two frames past where it could settle.
 *
 * Bounded HALF of `resolveFileDiff`'s own 16-entry cache: resolving ahead rows
 * must never evict the entries other callers (the hover intent here, the
 * transcript's tool diffs) are about to mount, because eviction re-mints the
 * content's cacheKey and orphans the worker highlight stored under the old one.
 */
const AHEAD_PRIME_ROWS = 8

/**
 * Run `work` once the main thread is idle, returning a cancel.
 *
 * Ahead priming has no deadline — it is a head start for a press that has not
 * happened — but its parse-and-dispatch is main-thread work, and the moment a
 * review surface learns its diffs is the tail of a measured interaction
 * (opening the panel, switching to Changes). Idle scheduling keeps the head
 * start out of exactly the frames those interactions are settling in.
 */
function whenIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(() => work(), { timeout: 500 })
    return () => cancelIdleCallback(handle)
  }
  const timer = setTimeout(work, 200)
  return () => clearTimeout(timer)
}

export type ReviewDiffPrime = {
  /** Report the row the pointer has come to rest on, or `undefined` for none. */
  intend: (file: string | undefined) => void
}

/**
 * Syntax-highlight, in the worker, every diff the surface is ABOUT to mount.
 *
 * Expanding a review row whose diff the highlight worker has never seen
 * renders it three times: `DiffHunksRenderer` builds a plain AST on the main
 * thread (intra-line word diffing included), applies it to the shadow tree,
 * and then replaces every row again when the worker's highlighted result
 * arrives — the last of those landing AFTER the click has been acknowledged,
 * as re-render and scroll-correction jank.
 *
 * Two signals say a diff is about to be mounted, and both are known well
 * before the press that mounts it:
 *
 * 1. The pointer resting on a collapsed row. Pressing it expands the row, and
 *    the hover already fetches its content; priming is the same worker
 *    request, issued during the dwell instead of inside the press.
 * 2. A mounted large-diff guard pane. A row past the render ceiling expands to
 *    a confirmation pane whose ONLY action is "render anyway" — so while the
 *    user reads that confirmation the app already knows the exact diff the
 *    next press mounts. Without this the force press paid the full three-pass
 *    render that priming exists to remove.
 *
 * The policy is only "what would this press actually mount": a row still
 * waiting for its content and a media file mount something other than a diff,
 * and priming them would highlight something nobody is going to look at. The
 * render ceiling gates signal 1 only — a press on a collapsed above-ceiling
 * row mounts the guard pane, not a diff — and never signal 2, where forcing IS
 * the press being primed for. Priming never fetches: it rides the content the
 * hover (or the guard pane) asked for, and does nothing until that content is
 * here.
 */
export function createReviewDiffPrime(input: {
  diffs: () => readonly ReviewDiffShape[]
  diffStyle: () => "unified" | "split"
  isForcedFile: (file: string) => boolean
  /** Whether the row is expanded — an above-ceiling one is showing its guard pane. */
  isExpandedFile: (file: string) => boolean
}): ReviewDiffPrime {
  const [intendedFile, setIntendedFile] = createSignal<string | undefined>()

  /** Is this row showing the large-diff guard pane rather than a diff? */
  const guarded = (diff: ReviewDiffShape) =>
    input.isExpandedFile(diff.file) &&
    exceedsDiffLimit({
      changedLines: changedLineCount(diff),
      expanded: true,
      forced: input.isForcedFile(diff.file),
      media: !!mediaKindFromPath(diff.file),
    })

  /**
   * The metadata a press on this row would mount, or `undefined` when it would
   * mount no diff. `forcing` is true for a row already showing its guard pane:
   * the ceiling that hid its diff is exactly what that pane's press lifts, so
   * it does not gate there — while for a collapsed row it still does.
   */
  const pendingFileDiff = (diff: ReviewDiffShape, forcing: boolean) => {
    if (!hasDiffContent(diff) || mediaKindFromPath(diff.file)) return
    const tooLarge = exceedsDiffLimit({
      changedLines: changedLineCount(diff),
      expanded: true,
      forced: forcing || input.isForcedFile(diff.file),
      media: false,
    })
    if (tooLarge) return
    return resolveFileDiff(diff)
  }

  /**
   * Everything a press is about to mount: the row under the resting pointer,
   * plus every row already showing a guard pane. Re-derived when a row's
   * content arrives, which is what lets an intent (or a guard pane) on a
   * not-yet-loaded row still prime once the content lands.
   */
  const pendingFileDiffs = createMemo(() => {
    const intended = intendedFile()
    return input.diffs()
      .flatMap((diff) => {
        const isGuarded = guarded(diff)
        if (!isGuarded && diff.file !== intended) return []
        const pending = pendingFileDiff(diff, isGuarded)
        return pending ? [pending] : []
      })
  })

  // One request per (style, content): coming back to a row already primed, or
  // re-deriving it because some other file's content landed, asks for nothing.
  // Bounded, so sweeping a 500-file corpus cannot grow the record without end;
  // forgetting a key only costs a repeat call, which the pool answers from its
  // own cache.
  const primed = new Set<string>()
  const primeResolved = (style: "unified" | "split", fileDiff: ReturnType<typeof resolveFileDiff>) => {
    if (!fileDiff.cacheKey) return
    const key = `${style}\0${fileDiff.cacheKey}`
    if (primed.has(key)) return
    if (primed.size >= PRIMED_KEY_LIMIT) primed.clear()
    primed.add(key)
    primeDiffHighlight(style, fileDiff)
  }

  createEffect(() => {
    const style = input.diffStyle()
    for (const fileDiff of pendingFileDiffs()) primeResolved(style, fileDiff)
  })

  /**
   * The first-fold rows a press could mount without a dwell (see
   * AHEAD_PRIME_ROWS). Only which rows qualify is derived here — resolving
   * them (the parse that stamps the cacheKey) waits for the idle callback.
   */
  const aheadDiffs = createMemo(() =>
    input.diffs()
      .slice(0, AHEAD_PRIME_ROWS)
      .filter((diff) =>
        hasDiffContent(diff) &&
        !mediaKindFromPath(diff.file) &&
        !exceedsDiffLimit({
          changedLines: changedLineCount(diff),
          expanded: true,
          forced: input.isForcedFile(diff.file),
          media: false,
        }),
      ),
  )

  let cancelAheadPrime: (() => void) | undefined
  createEffect(() => {
    const style = input.diffStyle()
    const ahead = aheadDiffs()
    cancelAheadPrime?.()
    cancelAheadPrime = undefined
    if (ahead.length === 0) return
    cancelAheadPrime = whenIdle(() => {
      for (const diff of ahead) primeResolved(style, resolveFileDiff(diff))
    })
  })
  onCleanup(() => cancelAheadPrime?.())

  return { intend: setIntendedFile }
}
