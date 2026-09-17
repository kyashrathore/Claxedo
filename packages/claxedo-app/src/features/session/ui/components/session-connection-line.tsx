import { Show, createMemo, type Accessor } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import {
  streamSyncLifecycleSnapshot,
  type StreamSyncSnapshot,
  type StreamSyncStreamId,
} from "@/platform/runtime/stream-sync-status"

/**
 * Pure so the state → shown/hidden mapping is testable without mounting Solid.
 *
 * Shows only for `"reconnect-scheduled"` on a stream that has reached `"live"`
 * at least once (`snapshot.everLive`). A fresh session's first connect —
 * `"connecting"`, or an early `"reconnect-scheduled"` after a failed first
 * attempt — is ordinary startup and renders nothing; only a drop after a
 * healthy connection is a reconnect.
 *
 * `"stopped"` never shows the line: the events provider stops a stream only on
 * deliberate teardown and nothing reconnects it, so "Reconnecting…" would never
 * clear. Teardown also clears the snapshot (`clearStreamSyncLifecycle`); this
 * branch is defense in depth.
 */
export function shouldShowConnectionLine(snapshot: StreamSyncSnapshot | undefined): boolean {
  if (!snapshot || !snapshot.everLive) return false
  return snapshot.state === "reconnect-scheduled"
}

/**
 * A quiet advisory in the composer `beforeInput` slot, beneath
 * `SessionHealthPeek`, while this session's live event stream has dropped and
 * is retrying: one centred line, no fill, no rail, no colour — a loading state,
 * never an error. Copy names the effect ("Reconnecting…"), never the transport.
 * Renders nothing on a healthy session or during a fresh session's first
 * connect (`shouldShowConnectionLine`).
 *
 * The `beforeInput` slot is a plain `JSX.Element` evaluated once, so the
 * subscription to the stream-sync store must live inside this component, not
 * in the caller's synchronous body.
 */
export function SessionConnectionLine(props: { workspaceId: Accessor<string | undefined> }) {
  const streamId = createMemo<StreamSyncStreamId>(() => {
    const workspaceId = props.workspaceId()
    return workspaceId ? (`wr:${workspaceId}` as const) : "cp"
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
