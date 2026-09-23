import type { CodeViewItem, DiffLineAnnotation } from "@pierre/diffs"
import { resolveFileDiff, type DiffSource } from "./session-diff"

type Entry<LAnnotation> = {
  source: DiffSource
  annotations: DiffLineAnnotation<LAnnotation>[] | undefined
  item: CodeViewItem<LAnnotation>
}

export type ReviewCodeViewItemsInput<LAnnotation> = {
  diffs: readonly DiffSource[]
  open: ReadonlySet<string>
  /** Files whose body the caller supplies instead of a parsed text diff. */
  customFiles?: ReadonlySet<string>
  /**
   * A file's comment annotations. Read for every file, not just rendered ones,
   * because an annotation occupies document height wherever it sits. Return the
   * same array while the file's comments and draft are unchanged: a new array
   * is what tells CodeView to re-measure the item.
   */
  annotations?: (file: string) => DiffLineAnnotation<LAnnotation>[] | undefined
}

/** Retain parsed content for the current document, independently of rendered DOM. */
export function createReviewCodeViewItems<LAnnotation = undefined>() {
  let previous = new Map<string, Entry<LAnnotation>>()
  return ({ diffs, open, customFiles, annotations }: ReviewCodeViewItemsInput<LAnnotation>): CodeViewItem<LAnnotation>[] => {
    const next = new Map<string, Entry<LAnnotation>>()
    const items = diffs.map((diff) => {
      const cached = previous.get(diff.file)
      const sameContent = cached && (typeof diff.patch === "string"
        ? cached.source.patch === diff.patch
        : cached.source.patch === undefined && cached.source.before === diff.before && cached.source.after === diff.after)
      const collapsed = !open.has(diff.file)
      const loaded = typeof diff.patch === "string" || typeof diff.before === "string" || typeof diff.after === "string"
      const type = loaded && !customFiles?.has(diff.file) ? "diff" : "custom"
      const fileAnnotations = type === "diff" ? annotations?.(diff.file) : undefined
      const reusable = sameContent
        && cached.item.collapsed === collapsed
        && cached.item.type === type
        && cached.annotations === fileAnnotations
      const item: CodeViewItem<LAnnotation> = reusable ? cached.item : type === "diff" ? {
        id: diff.file,
        type: "diff" as const,
        fileDiff: sameContent && cached.item.type === "diff" ? cached.item.fileDiff : resolveFileDiff(diff),
        ...(fileAnnotations && fileAnnotations.length > 0 ? { annotations: fileAnnotations } : {}),
        collapsed,
        version: (cached?.item.version ?? -1) + 1,
      } : {
        id: diff.file,
        type: "custom",
        collapsed,
        version: (cached?.item.version ?? -1) + 1,
      }
      // Copy the fields: callers can supply reactive store proxies whose values
      // change in place. Keeping the proxy would hide a content replacement.
      next.set(diff.file, {
        source: { file: diff.file, patch: diff.patch, before: diff.before, after: diff.after },
        annotations: fileAnnotations,
        item,
      })
      return item
    })
    previous = next
    return items
  }
}
