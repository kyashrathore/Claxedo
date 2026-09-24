import { Match, Show, Switch } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

export type SessionStatusStage = "redispatch" | "pending" | "long" | "failed" | undefined

export interface SessionStatusStageProps {
  /** Current timeout stage from dispatcher-owned prompt status metadata. */
  stage: SessionStatusStage
  /** Called when the user clicks Cancel. Should stop the running turn. */
  onCancel: () => void
  /**
   * Optional: called when the user clicks Retry. Only rendered at the
   * `"failed"` stage and only when this prop is provided. The composer is
   * responsible for restoring "last submitted prompt" state and re-running
   * its submit pipeline. If omitted, only Cancel appears at the failed
   * stage (pre-Retry behavior).
   */
  onRetry?: () => void
  /**
   * Whether the session is still in a busy/retry state. The "failed" stage
   * is only meaningful while the session is still optimistically busy —
   * once a real server status arrives, meta is cleared and this component
   * is hidden via `stage === undefined`. Defaults to true.
   */
  busy?: boolean
}

/**
 * Renders the visible-pending → cancel surface for the session-status
 * timeout. Mount this beside the composer submit button. Render nothing
 * for stages that the existing busy spinner already covers.
 */
export function SessionStatusStage(props: SessionStatusStageProps) {
  const busy = () => props.busy !== false
  const visible = () => busy() && (props.stage === "pending" || props.stage === "long" || props.stage === "failed")

  return (
    <Show when={visible()}>
      <Switch>
        <Match when={props.stage === "pending"}>
          <div
            data-testid="session-status-stage"
            data-stage="pending"
            class="flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak"
            role="status"
            aria-live="polite"
          >
            <Spinner class="size-3.5 shrink-0" />
            <span>Still working…</span>
          </div>
        </Match>
        <Match when={props.stage === "long"}>
          <div
            data-testid="session-status-stage"
            data-stage="long"
            class="flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak"
            role="status"
            aria-live="polite"
          >
            <Spinner class="size-3.5 shrink-0" />
            <span>This is taking a while</span>
            <button
              type="button"
              data-action="session-status-cancel"
              class="ml-1 rounded-sm px-1.5 py-0.5 text-12-medium text-text-base hover:bg-surface-raised-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                props.onCancel()
              }}
            >
              Cancel
            </button>
          </div>
        </Match>
        <Match when={props.stage === "failed"}>
          <div
            data-testid="session-status-stage"
            data-stage="failed"
            class="flex items-center gap-1.5 rounded-md border border-border-strong-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base"
            role="alert"
            aria-live="assertive"
          >
            <Icon name="warning" size="small" class="text-icon-base shrink-0" />
            <span>Session is unresponsive</span>
            <button
              type="button"
              data-action="session-status-cancel"
              class="ml-1 rounded-sm px-1.5 py-0.5 text-12-medium text-text-base hover:bg-surface-raised-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                props.onCancel()
              }}
            >
              Cancel
            </button>
            <Show when={props.onRetry}>
              <button
                type="button"
                data-action="session-status-retry"
                class="rounded-sm px-1.5 py-0.5 text-12-medium text-text-base hover:bg-surface-raised-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onRetry?.()
                }}
              >
                Retry
              </button>
            </Show>
          </div>
        </Match>
      </Switch>
    </Show>
  )
}
