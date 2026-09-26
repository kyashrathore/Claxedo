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
  customFiles?: ReadonlySet<string>
  annotations?: (file: string) => DiffLineAnnotation<LAnnotation>[] | undefined
}

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
