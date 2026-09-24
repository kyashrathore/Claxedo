import { Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import type { PlacementId } from "@/server"
import { Icon } from "@/ui"
import { useReviewApi } from "../api"
import { dictionary } from "../i18n"
import { FailureText } from "./flow-notice"

export function StatusLine(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const status = useQuery(() => api.status(props.placementId))
  return (
    <>
    <Show when={status.error}>
      {(error) => (
        <div class="shrink-0 border-b border-border-muted px-3 py-1 text-xs">
          <FailureText error={error()} />
        </div>
      )}
    </Show>
    <Show when={status.data}>
      {(current) => (
        <div data-testid="review-status" class="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-muted px-3 py-1 text-xs text-text-muted">
          <Show when={current().branch}>
            {(branch) => (
              <span class="flex min-w-0 items-center gap-1 break-all text-text-base">
                <Icon name="branch" size="small" />
                {t("review.status.branch", { branch: branch() })}
              </span>
            )}
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
    </>
  )
}
