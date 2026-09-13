import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"

/**
 * The next page of a list the server said it has more of.
 *
 * The host passes this only while a cursor is outstanding, so the control's
 * presence is the server's answer rather than a guess from the page size.
 */
export type MorePages = {
  onLoadMore: () => void
  loading?: boolean
  error?: string
}

export function LoadMore(props: { more?: MorePages; testId: string }) {
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
            {more().loading === true ? "Loading…" : more().error !== undefined ? "Retry" : "Load more"}
          </Button>
        </div>
      )}
    </Show>
  )
}
