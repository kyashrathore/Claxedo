import { Show, createMemo, type Accessor } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import {
  streamSyncLifecycleSnapshot,
  type StreamSyncSnapshot,
  type StreamSyncStreamId,
} from "@/platform/runtime/stream-sync-status"

/**
 * Visibility derivation for the reconnect line (B5 / T7), factored out as a
 * pure function so the state → shown/hidden mapping — including first-connect
 * suppression — is testable without mounting Solid.
 *
 * Mounts only for `"reconnect-scheduled"` and `"stopped"`, and only once the
 * stream has proven itself by reaching `"live"` at least once
 * (`snapshot.everLive`). That second guard is what suppresses the line during
 * the first connect of a fresh session: a brand-new stream that has not yet
 * gone live is ordinary startup — `"connecting"`, or even an early
 * `"reconnect-scheduled"` from a first-attempt failure that has not yet
 * succeeded once — never renders anything. Only a stream that was `"live"`
 * and then dropped counts as a *reconnect*.
 */
export function shouldShowConnectionLine(snapshot: StreamSyncSnapshot | undefined): boolean {
  if (!snapshot || !snapshot.everLive) return false
  return snapshot.state === "reconnect-scheduled" || snapshot.state === "stopped"
}

/**
 * A quiet advisory rendered in the composer `beforeInput` slot, beneath
 * `SessionHealthPeek`, when this session's live event stream has dropped and
 * is retrying. Muted anatomy (§2): one centred line, no fill, no rail, no
 * colour — the same visual register as a loading state, never an error
 * (E§5.6). Copy names the effect ("Reconnecting…"), never the transport — no
 * "SSE", no "relay". Renders nothing (zero chrome / zero layout shift) on a
 * healthy session, and — critically — during the first connect of a fresh
 * session (see `shouldShowConnectionLine`).
 *
 * Reactivity gotcha (§2 constraint 6): the `beforeInput` slot is a plain
 * `JSX.Element` evaluated once, so the subscription to the stream-sync
 * lifecycle store lives *inside* this component, never in the caller's
 * synchronous body.
 */
export function SessionConnectionLine(props: { workspaceId: Accessor<string | undefined> }) {
  const streamId = createMemo<StreamSyncStreamId>(() => {
    const workspaceId = props.workspaceId()
    return workspaceId ? (`workspace:${workspaceId}` as const) : "central"
  })

  const visible = createMemo(() => shouldShowConnectionLine(streamSyncLifecycleSnapshot(streamId())))

  // STABLE ROOT, VISIBILITY BY CSS — deliberately not a `<Show>`. This line
  // flaps with stream health (live ↔ reconnect-scheduled), and it renders in
  // the composer's `beforeInput` slot as a SIBLING of the prompt input. A
  // `<Show>` mount/unmount changes that slot's rendered shape, and the
  // resulting insertExpression reconcile rebuilds the dock's children — the
  // focused contenteditable is removed and re-inserted, dropping focus to
  // <body> and closing any open composer popover mid-typing (observed: every
  // pill unmount blurred the composer and killed the slash popover). Keeping
  // one stable node and toggling `display` gives the same zero-chrome result
  // with no sibling DOM churn.
  return (
    <div
      role="status"
      aria-live="polite"
      class="flex items-center justify-center gap-2 px-4 py-1 text-13-regular text-text-weak"
      style={{ display: visible() ? undefined : "none" }}
    >
      <Show when={visible()}>
        <Spinner class="size-4" /> Reconnecting…
      </Show>
    </div>
  )
}
