import { createMemo, type Accessor } from "solid-js"
import type { SelectedLineRange } from "@pierre/diffs"
import { sessionComposerKey, useComposerStore, type ComposerKey, type ContextItem } from "@/composer"
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
  readonly composerKey: Accessor<ComposerKey | undefined>
  readonly comments: Accessor<readonly ReviewComment[]>
  readonly add: (input: ReviewCommentInput) => void
  readonly update: (id: string, input: ReviewCommentInput) => void
  readonly remove: (id: string) => void
}

export type CommentOrigin = "review" | "file"

type FileContextItem = Extract<ContextItem, { type: "file" }>

const contextKey = (origin: CommentOrigin, id: string) => `${origin}:${id}`

function commentOf(item: ContextItem, origin: CommentOrigin): ReviewComment | undefined {
  if (item.type !== "file" || item.commentOrigin !== origin) return undefined
  if (!item.commentId || !item.comment || !item.selection) return undefined
  const selection = { start: item.selection.startLine, end: item.selection.endLine }
  return { id: item.commentId, file: item.path, selection, comment: item.comment }
}

function contextItemOf(origin: CommentOrigin, id: string, input: ReviewCommentInput): FileContextItem {
  const startLine = Math.min(input.selection.start, input.selection.end)
  const endLine = Math.max(input.selection.start, input.selection.end)
  return {
    type: "file",
    key: contextKey(origin, id),
    path: input.file,
    selection: { startLine, startChar: 0, endLine, endChar: 0 },
    comment: input.comment,
    commentId: id,
    commentOrigin: origin,
    ...(input.preview === undefined ? {} : { preview: input.preview }),
  }
}

export function useLineComments(origin: CommentOrigin): ReviewComments {
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
      const comment = commentOf(item, origin)
      return comment ? [comment] : []
    })
  })
  const withKey = (run: (current: string) => void) => {
    const current = key()
    if (current) run(current)
  }
  return {
    enabled: () => key() !== undefined,
    composerKey: key,
    comments,
    add: (input) => withKey((current) => composer.addContext(current, contextItemOf(origin, uuid(), input))),
    update: (id, input) =>
      withKey((current) => {
        const next = contextItemOf(origin, id, input)
        const key = contextKey(origin, id)
        composer.setContext(current, composer.draft(current).context.map((item) => (item.key === key ? next : item)))
      }),
    remove: (id) => withKey((current) => composer.removeContext(current, contextKey(origin, id))),
  }
}
