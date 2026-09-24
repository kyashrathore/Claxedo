import { createMemo, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { PlacementId } from "@/server"
import { fetchView } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"

export function StatusLine(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const query = useQuery(() => api.status(props.placementId))
  const status = createMemo(() => {
    const view = fetchView(query)
    return view.kind === "ready" ? view.data : undefined
  })
  return (
    <Show when={status()}>
      {(current) => (
        <div
          data-component="review-status"
          class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-weak-base px-3 py-1 text-11-regular text-text-weak"
        >
          <Show when={current().branch}>
            {(branch) => <span class="min-w-0 break-all text-text-base">{t("review.status.branch", { branch: branch() })}</span>}
          </Show>
          <Show when={current().upstream} fallback={<span>{t("review.status.noUpstream")}</span>}>
            <Show when={current().ahead > 0}>
              <span>{t("review.status.ahead", { count: current().ahead })}</span>
            </Show>
            <Show when={current().behind > 0}>
              <span>{t("review.status.behind", { count: current().behind })}</span>
            </Show>
            <Show when={current().ahead === 0 && current().behind === 0}>
              <span>{t("review.upToDate")}</span>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  )
}
