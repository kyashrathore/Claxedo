import { Show, type JSX } from "solid-js"
import { t } from "../i18n"
import { useReview } from "../store"
import { ChangedFiles } from "./changed-files"
import { CommitBox } from "./commit-box"
import { PendingComments } from "./pending-comments"
import { ScopePicker } from "./scope-picker"
import { StatusLine } from "./status-line"
import { Worktrees } from "./worktrees"

export function ChangesTab(): JSX.Element {
  const review = useReview()
  return (
    <div data-component="changes-tab" class="flex size-full min-h-0 flex-col overflow-auto bg-background-base">
      <Show
        when={review.placementId()}
        fallback={<div class="px-3 py-6 text-center text-12-regular text-text-weak">{t("review.noPlacement")}</div>}
      >
        {(placementId) => (
          <>
            <ScopePicker placementId={placementId()} />
            <StatusLine placementId={placementId()} />
            <ChangedFiles placementId={placementId()} />
            <PendingComments />
            <CommitBox placementId={placementId()} />
            <Worktrees placementId={placementId()} />
          </>
        )}
      </Show>
    </div>
  )
}
