import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import type { ListFailure, MorePages } from "../data/queries"
import { tasksDictionary } from "../i18n"

export function LoadMore(props: { readonly more?: MorePages; readonly testId: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const label = (more: MorePages) => {
    if (more.loading === true) return t("tasks.loading")
    return more.error !== undefined ? t("tasks.retry") : t("tasks.loadMore")
  }
  return (
    <Show when={props.more}>
      {(more) => (
        <div class="tsk-row tsk-inset">
          <Show when={more().error}>
            {(message) => (
              <p class="tsk-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Button
            size="small"
            variant="ghost"
            data-testid={props.testId}
            disabled={more().loading === true}
            onClick={() => more().onLoadMore()}
          >
            {label(more())}
          </Button>
        </div>
      )}
    </Show>
  )
}

export function ListFailureNotice(props: { readonly failure?: ListFailure; readonly testId: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.failure}>
      {(failure) => (
        <div class="tsk-row tsk-inset">
          <p class="tsk-error" role="alert">
            {failure().message}
          </p>
          <Button
            size="small"
            data-testid={props.testId}
            disabled={failure().retrying === true}
            onClick={() => failure().onRetry()}
          >
            {failure().retrying === true ? t("tasks.retrying") : t("tasks.retry")}
          </Button>
        </div>
      )}
    </Show>
  )
}
