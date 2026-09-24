import { createMemo, type Accessor } from "solid-js"
import type { PromptAttachment } from "@/server"
import { commentAttachment, commentLabel } from "./model"
import { useReview } from "./store"

export type ComposerItem = {
  readonly id: string
  readonly label: string
  readonly attachment: PromptAttachment
}

export type ComposerItems = {
  readonly items: Accessor<readonly ComposerItem[]>
  readonly remove: (id: string) => void
  readonly take: () => readonly PromptAttachment[]
}

export function useReviewComments(): ComposerItems {
  const review = useReview()
  const items = createMemo(() =>
    review.comments().map((comment) => ({ id: comment.id, label: commentLabel(comment), attachment: commentAttachment(comment) })),
  )
  return {
    items,
    remove: (id) => review.removeComment(id),
    take: () => review.takeComments().map(commentAttachment),
  }
}
