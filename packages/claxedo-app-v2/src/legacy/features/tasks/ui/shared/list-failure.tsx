import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"

/**
 * A list read that came back refused, with the retry that runs it again.
 *
 * Distinct from `MorePages`: this is the read that produced no list at all, so
 * a surface that shows it must not also offer its empty state — an empty list
 * and an unread one are different answers.
 */
export type ListFailure = {
  message: string
  onRetry: () => void
  retrying?: boolean
}

export function ListFailureNotice(props: { failure?: ListFailure; testId: string }) {
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
            {failure().retrying === true ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}
    </Show>
  )
}
