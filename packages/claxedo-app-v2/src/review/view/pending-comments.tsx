import { For, Show, type JSX } from "solid-js"
import { t } from "../i18n"
import { commentLabel, commentRangeLabel } from "../model"
import { useReview } from "../store"

export function PendingComments(): JSX.Element {
  const review = useReview()
  return (
    <Show when={review.comments().length > 0}>
      <section data-component="review-comments" aria-label={t("review.comment.pending")} class="flex flex-col gap-1 border-t border-border-weak-base px-3 py-2">
        <h3 class="text-11-regular text-text-weak">{t("review.comment.pending")}</h3>
        <ul class="flex flex-col gap-1">
          <For each={review.comments()}>
            {(comment) => (
              <li class="flex items-start gap-2 rounded-md bg-surface-base px-2 py-1 text-12-regular">
                <span class="min-w-0 flex-1">
                  <span class="break-all text-text-base">{commentLabel(comment)}</span>
                  <span class="text-text-weaker"> · {commentRangeLabel(comment)}</span>
                  <span class="block break-words text-text-weak">{comment.text}</span>
                </span>
                <button
                  type="button"
                  aria-label={`${t("review.comment.remove")} ${commentLabel(comment)}`}
                  class="flex size-7 shrink-0 items-center justify-center rounded text-text-weak hover:bg-surface-base-hover hover:text-text-base pointer-coarse:size-11"
                  onClick={() => review.removeComment(comment.id)}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
