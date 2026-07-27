// Rubric A2: surfaces the optimistic-status timeout stage to the user.
//
// The dispatcher in `session/store/session-status-dispatcher.ts` escalates
// prompt session status metadata from `undefined` →
// `"redispatch"` → `"pending"` → `"long"` → `"failed"` based on how long
// an optimistic busy state has gone without a server-source update.
//
// This component is a passive consumer of that stage. It renders next to
// the composer submit button and:
//
// - hides itself for `undefined` / `"redispatch"` (the upstream busy spinner
//   on the submit button is sufficient),
// - shows a quiet "Still working…" hint at `"pending"`,
// - shows a "This is taking a while" warning + Cancel button at `"long"`,
// - shows "Session is unresponsive" + Cancel at `"failed"`.
//
// Cancel calls `onCancel` (wired to the existing `abort()` action in
// prompt-input.tsx, which idempotently fires `session.abort`). Retry is
// optional and only meaningful at the `"failed"` stage: when provided,
// the composer hoists "last submitted prompt" state (text + parts + agent
// + model + variant + attachments) and re-runs its submit pipeline. This
// leaf component only renders the button and forwards the click; the
// callback owner decides whether a retry is safe (no-op when nothing was
// ever submitted from this composer instance).
import { Match, Show, Switch } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

export type SessionStatusStage = "redispatch" | "pending" | "long" | "failed" | undefined

export interface SessionStatusStageProps {
  /** Current timeout stage from dispatcher-owned prompt status metadata. */
  stage: SessionStatusStage
  /** Called when the user clicks Cancel. Should call `session.abort`. */
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
