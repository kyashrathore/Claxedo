import { createEffect, createMemo, createSignal } from "solid-js"
import { changedLineCount, exceedsDiffLimit, hasDiffContent, type ReviewDiffShape } from "./review-session-logic"
import { mediaKindFromPath, resolveFileDiff } from "@/ui/session-kit"
import { primeDiffHighlight } from "@/ui/session-kit-loaders"

export type ReviewHoverPrime = {
  /** Report the row the pointer has come to rest on, or `undefined` for none. */
  intend: (file: string | undefined) => void
}

/**
 * Syntax-highlight the row under the resting pointer BEFORE it is expanded.
 *
 * Expanding a review row whose diff the highlight worker has never seen
 * renders it three times: `DiffHunksRenderer` builds a plain AST on the main
 * thread (intra-line word diffing included), applies it to the shadow tree,
 * and then replaces every row again when the worker's highlighted result
 * arrives — the last of those landing AFTER the click has been acknowledged,
 * as re-render and scroll-correction jank.
 *
 * The hover already tells the surface which row is about to be pressed and
 * already fetches its content. Priming is the natural continuation: the same
 * worker request, issued during the dwell instead of inside the press, so the
 * expand mounts already-highlighted rows in one render.
 *
 * The policy is only "what would this press actually mount": a row still
 * waiting for its content, one past the render ceiling, and a media file all
 * mount something other than a diff, and priming them would highlight
 * something nobody is going to look at. Priming never fetches — it rides the
 * content the hover asked for, and does nothing until that content is here.
 */
export function createReviewHoverPrime(input: {
  diffs: () => readonly ReviewDiffShape[]
  diffStyle: () => "unified" | "split"
  isForcedFile: (file: string) => boolean
}): ReviewHoverPrime {
  const [intendedFile, setIntendedFile] = createSignal<string | undefined>()

  /**
   * The metadata a press on the intended row would mount, or `undefined` when
   * it would mount no diff. Re-derived when the row's content arrives, which
   * is what lets a hover on a not-yet-loaded row still prime.
   */
  const intendedFileDiff = createMemo(() => {
    const file = intendedFile()
    if (file === undefined) return
    const diff = input.diffs().find((item) => item.file === file)
    if (!diff || !hasDiffContent(diff) || mediaKindFromPath(file)) return
    const tooLarge = exceedsDiffLimit({
      changedLines: changedLineCount(diff),
      expanded: true,
      forced: input.isForcedFile(file),
      media: false,
    })
    if (tooLarge) return
    return resolveFileDiff(diff)
  })

  // One request per (style, content): coming back to a row already primed, or
  // re-deriving it because some other file's content landed, asks for nothing.
  let primed: string | undefined
  createEffect(() => {
    const fileDiff = intendedFileDiff()
    const style = input.diffStyle()
    if (!fileDiff?.cacheKey) return
    const key = `${style}\0${fileDiff.cacheKey}`
    if (key === primed) return
    primed = key
    primeDiffHighlight(style, fileDiff)
  })

  return { intend: setIntendedFile }
}
