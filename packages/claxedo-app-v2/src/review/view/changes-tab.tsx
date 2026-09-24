import { Show, type JSX } from "solid-js"
import { useActiveSession } from "@/files"
import { useTranslator } from "@/i18n"
import { useReviewCommands } from "../commands"
import { dictionary } from "../i18n"
import { useReview } from "../store"
import { CommitBox } from "./commit-box"
import { ReviewDiffs } from "./review-diffs"
import { ScopePicker } from "./scope-picker"
import { StatusLine } from "./status-line"
import { Worktrees } from "./worktrees"

export function ChangesTab(): JSX.Element {
  const t = useTranslator(dictionary)
  const review = useReview()
  const session = useActiveSession()
  useReviewCommands(review)
  return (
    <div data-testid="changes-tab" class="flex size-full min-h-0 flex-col bg-background-base">
      <Show when={review.placementId()} keyed fallback={<p class="px-3 py-6 text-center text-sm text-text-muted">{t("review.noPlacement")}</p>}>
        {(placementId) => (
          <>
            <StatusLine placementId={placementId} />
            <ScopePicker placementId={placementId} />
            <Show when={!session()}>
              <p class="shrink-0 px-3 py-1 text-xs text-text-muted">{t("review.comment.needSession")}</p>
            </Show>
            <div class="flex min-h-0 flex-1 flex-col">
              <ReviewDiffs placementId={placementId} />
            </div>
            <CommitBox placementId={placementId} />
            <Worktrees placementId={placementId} />
          </>
        )}
      </Show>
    </div>
  )
}
