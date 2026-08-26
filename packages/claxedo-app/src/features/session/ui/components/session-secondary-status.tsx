import { Show, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { SessionHealthPeek } from "./session-health-peek"
import { SessionConnectionLine } from "./session-connection-line"

export const SESSION_SECONDARY_STATUS_DELAY_MS = 250

/**
 * Healthy sessions render neither status row, but mounting the rows eagerly
 * still starts the harness health probe and stream-status subscriptions inside
 * the transcript/composer first-paint window. They are advisory secondary
 * chrome: wait until the real first fold is ready, then mount them outside the
 * activation window. The composer and its submit-readiness authority remain
 * mounted normally; this only delays the two informational observers.
 */
export function DeferredSessionSecondaryStatus(props: {
  active: Accessor<boolean>
  firstFoldReady: Accessor<boolean>
  directory: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
  workspaceId: Accessor<string | undefined>
  delayMs?: number
}) {
  const [mounted, setMounted] = createSignal(false)
  createEffect(() => {
    if (mounted() || !props.active() || !props.firstFoldReady()) return
    const timer = setTimeout(
      () => setMounted(true),
      props.delayMs ?? SESSION_SECONDARY_STATUS_DELAY_MS,
    )
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <Show when={mounted()}>
      <SessionHealthPeek
        active={props.active}
        directory={props.directory}
        sessionId={props.sessionId}
      />
      <SessionConnectionLine workspaceId={props.workspaceId} />
    </Show>
  )
}
