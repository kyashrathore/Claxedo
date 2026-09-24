import { createMemo, type Accessor } from "solid-js"
import type { SelectedLineRange } from "@pierre/diffs"
import { sessionComposerKey, useComposerStore, type ContextItem } from "@/composer"
import { useActiveSession } from "@/files"
import { uuid } from "@/lib/uuid"

export type ReviewComment = {
  readonly id: string
  readonly file: string
  readonly selection: SelectedLineRange
  readonly comment: string
}

export type ReviewCommentInput = {
  readonly file: string
  readonly selection: SelectedLineRange
  readonly comment: string
  readonly preview?: string
}

export type ReviewComments = {
  readonly enabled: Accessor<boolean>
  readonly comments: Accessor<readonly ReviewComment[]>
  readonly add: (input: ReviewCommentInput) => void
  readonly update: (id: string, input: ReviewCommentInput) => void
  readonly remove: (id: string) => void
}

type FileContextItem = Extract<ContextItem, { type: "file" }>

const contextKey = (id: string) => `review:${id}`

function reviewCommentOf(item: ContextItem): ReviewComment | undefined {
  if (item.type !== "file" || item.commentOrigin !== "review") return undefined
  if (!item.commentId || !item.comment || !item.selection) return undefined
  const selection = { start: item.selection.startLine, end: item.selection.endLine }
  return { id: item.commentId, file: item.path, selection, comment: item.comment }
}

function contextItemOf(id: string, input: ReviewCommentInput): FileContextItem {
  const startLine = Math.min(input.selection.start, input.selection.end)
  const endLine = Math.max(input.selection.start, input.selection.end)
  return {
    type: "file",
    key: contextKey(id),
    path: input.file,
    selection: { startLine, startChar: 0, endLine, endChar: 0 },
    comment: input.comment,
    commentId: id,
    commentOrigin: "review",
    ...(input.preview === undefined ? {} : { preview: input.preview }),
  }
}

export function useReviewComments(): ReviewComments {
  const composer = useComposerStore()
  const session = useActiveSession()
  const key = createMemo(() => {
    const ref = session()
    return ref ? sessionComposerKey(ref) : undefined
  })
  const comments = createMemo(() => {
    const current = key()
    if (!current) return []
    return composer.draft(current).context.flatMap((item) => {
      const comment = reviewCommentOf(item)
      return comment ? [comment] : []
    })
  })
  const withKey = (run: (current: string) => void) => {
    const current = key()
    if (current) run(current)
  }
  return {
    enabled: () => key() !== undefined,
    comments,
    add: (input) => withKey((current) => composer.addContext(current, contextItemOf(uuid(), input))),
    update: (id, input) =>
      withKey((current) => {
        const next = contextItemOf(id, input)
        composer.setContext(current, composer.draft(current).context.map((item) => (item.key === contextKey(id) ? next : item)))
      }),
    remove: (id) => withKey((current) => composer.removeContext(current, contextKey(id))),
  }
}
