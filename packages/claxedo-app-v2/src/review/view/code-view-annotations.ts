import { createMemo, type Accessor } from "solid-js"
import type { SelectedLineRange } from "@pierre/diffs"
import type { LineCommentAnnotationMeta, ReviewCodeViewComments } from "@/transcript"
import type { ReviewComment } from "../comments"

export type ReviewAnnotationMeta = LineCommentAnnotationMeta<ReviewComment>
export type ReviewAnnotation = NonNullable<ReturnType<ReviewCodeViewComments<ReviewAnnotationMeta>["annotations"]>>[number]
export type FileRange = { readonly file: string; readonly range: SelectedLineRange }

export const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"
const annotationLine = (range: SelectedLineRange) => Math.max(range.start, range.end)

const sameRange = (a: SelectedLineRange, b: SelectedLineRange) =>
  a.start === b.start && a.end === b.end && a.side === b.side && a.endSide === b.endSide

function sameAnnotation(left: ReviewAnnotation, right: ReviewAnnotation): boolean {
  if (left.lineNumber !== right.lineNumber || left.side !== right.side) return false
  if (left.metadata.key !== right.metadata.key) return false
  if (left.metadata.kind === "comment" && right.metadata.kind === "comment") {
    return left.metadata.comment.comment === right.metadata.comment.comment && sameRange(left.metadata.comment.selection, right.metadata.comment.selection)
  }
  if (left.metadata.kind === "draft" && right.metadata.kind === "draft") return sameRange(left.metadata.range, right.metadata.range)
  return false
}

function sameAnnotations(a: readonly ReviewAnnotation[], b: readonly ReviewAnnotation[]): boolean {
  return a.length === b.length && a.every((left, index) => sameAnnotation(left, b[index]))
}

function commentAnnotation(comment: ReviewComment): ReviewAnnotation {
  return {
    side: selectionSide(comment.selection),
    lineNumber: annotationLine(comment.selection),
    metadata: { kind: "comment", key: `comment:${comment.id}`, comment },
  }
}

function draftAnnotation(draft: FileRange): ReviewAnnotation {
  return {
    side: selectionSide(draft.range),
    lineNumber: annotationLine(draft.range),
    metadata: { kind: "draft", key: `draft:${draft.file}`, range: draft.range },
  }
}

function annotationsByFile(comments: readonly ReviewComment[], draft: FileRange | null): Map<string, ReviewAnnotation[]> {
  const next = new Map<string, ReviewAnnotation[]>()
  for (const comment of comments) next.set(comment.file, [...(next.get(comment.file) ?? []), commentAnnotation(comment)])
  if (draft) next.set(draft.file, [...(next.get(draft.file) ?? []), draftAnnotation(draft)])
  return next
}

export function createReviewAnnotations(
  comments: Accessor<readonly ReviewComment[]>,
  draft: Accessor<FileRange | null>,
): (file: string) => ReviewAnnotation[] {
  const empty: ReviewAnnotation[] = []
  let retained = new Map<string, ReviewAnnotation[]>()
  const byFile = createMemo(() => {
    const next = annotationsByFile(comments(), draft())
    for (const [file, list] of next) {
      const previous = retained.get(file)
      if (previous && sameAnnotations(previous, list)) next.set(file, previous)
    }
    retained = next
    return next
  })
  return (file) => byFile().get(file) ?? empty
}
