import { Show } from "solid-js"

/**
 * The next page of a list the server said it has more of.
 *
 * The host passes this only while a cursor is outstanding, so the control's
 * presence is the server's answer rather than a guess from the page size.
 */
export type MorePages = {
  onLoadMore: () => void
  loading?: boolean
}

export function LoadMore(props: { more?: MorePages; testId: string }) {
  return (
    <Show when={props.more}>
      {(more) => (
        <div class="tsk-row">
          <button
            type="button"
            class="tsk-button"
            data-testid={props.testId}
            disabled={more().loading === true}
            onClick={() => more().onLoadMore()}
          >
            {more().loading === true ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </Show>
  )
}
