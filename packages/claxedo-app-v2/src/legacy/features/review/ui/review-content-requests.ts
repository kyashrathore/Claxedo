import { mediaKindFromPath } from "@/ui/session-kit"

/** Images/audio need file bytes; SVG stays a text diff so its source remains reviewable. */
export function isReviewMediaFile(path: string) {
  const kind = mediaKindFromPath(path)
  return kind === "image" || kind === "audio"
}

/** The part of the canonical file store a media row's load depends on. */
export type ReviewFileReader = {
  load: (path: string, options?: { force?: boolean }) => Promise<void>
  get: (path: string) => { content?: unknown; error?: string } | undefined
}

/**
 * Read a media row's bytes on behalf of the review's content queue.
 *
 * Two properties of the canonical file store shape this. It resolves against
 * whichever runtime is current when it is called, not when the request was
 * made, so a request outlived by its target abandons instead of reading. And it
 * records a failure and resolves rather than rejecting, so the state after the
 * read — not the promise — is what says whether the row has bytes; without that
 * the queue's error channel never fires and the row stays pending forever.
 */
export function reviewMediaLoad(input: {
  reader: ReviewFileReader
  path: string
  key: string
  /** The review target this request was made for. */
  targetKey: string
  currentTargetKey: () => string
  /** Keys the reader asked to retry, which must read past a cached failure. */
  retries: Set<string>
}) {
  return async () => {
    if (input.currentTargetKey() !== input.targetKey) return
    const force = input.retries.delete(input.key)
    await input.reader.load(input.path, force ? { force: true } : undefined)
    const state = input.reader.get(input.path)
    if (state?.content !== undefined) return
    throw new Error(state?.error ?? "File content is unavailable")
  }
}

/** What a row still needs before it can draw itself. */
export type ReviewContentRequestKind = "diff" | "media"

export type ReviewContentRequestPlan = {
  file: string
  kind: ReviewContentRequestKind
}

/**
 * Which of the rows the engine currently wants still owe a request, and of
 * which kind.
 *
 * The order is the caller's: the rendered range first, then its bounded
 * lookahead, so the queue starts with what is on screen. Everything here is a
 * decision about the current target — the caller binds each plan to the target
 * and client it was made against before anything is queued.
 */
export function reviewContentRequestPlan(input: {
  /** Rows the engine wants, visible ones first. */
  files: readonly string[]
  /** A row whose body is a media preview rather than a text diff. */
  isMedia: (file: string) => boolean
  /** A file removed by this change: it has no bytes left to read. */
  isDeleted: (file: string) => boolean
  /** The corpus knows this file at all. */
  isKnown: (file: string) => boolean
  /** The text diff is already in the review cache. */
  hasDiff: (file: string) => boolean
  /** The file's bytes are already in the canonical file cache. */
  hasMedia: (file: string) => boolean
  /** This file's last request failed and is waiting for the reader to retry. */
  hasError: (file: string) => boolean
}): ReviewContentRequestPlan[] {
  const seen = new Set<string>()
  const plans: ReviewContentRequestPlan[] = []
  for (const file of input.files) {
    if (seen.has(file)) continue
    seen.add(file)
    if (input.hasError(file)) continue
    if (input.isMedia(file)) {
      // A deleted media file has nothing to read, and its row says so from the
      // change itself.
      if (input.isDeleted(file) || input.hasMedia(file)) continue
      plans.push({ file, kind: "media" })
      continue
    }
    if (!input.isKnown(file) || input.hasDiff(file)) continue
    plans.push({ file, kind: "diff" })
  }
  return plans
}
