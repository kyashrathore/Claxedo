import { Match, Show, Switch, createEffect, type ParentProps } from "solid-js"
import type { JSX } from "@solidjs/web"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  CloudStartupView,
  WorkspaceAccessDeniedView,
  WorkspaceStateButton,
  WorkspaceStateNote,
  WorkspaceStateShell,
  useClaxedoEventsOptional,
} from "@/features/workspaces/app-ports"
import {
  acquireWorkspaceConnection,
  retryWorkspaceConnection,
  workspaceConnection,
  workspaceOffline,
  type WorkspaceConnectionKind,
  type WorkspaceOfflineReason,
} from "./workspace-connection"

// ONE component at the workspace-scope boundary. It wraps the WHOLE workspace
// surface (session pane(s), Review panel, composer/model picker, terminal), not
// just the center pane — everything that needs the runtime lives inside the
// `ready` branch and unlocks together. The sidebar session LIST stays OUTSIDE
// the gate (central-DB-driven) and remains live.
//
// The gate holds NO connection logic of its own — it acquires (ref-counted) for
// as long as it is mounted, then renders `workspaceConnection(id)`. Two gates
// over the same workspaceId (split mode) share ONE connection via the
// ref-count; two gates over different workspaceIds get independent entries.

const OFFLINE_COPY: Record<WorkspaceOfflineReason, { title: string; detail: string }> = {
  "no-host": {
    title: "Workspace host is offline",
    detail: "Start it by running `claxedo up` on the machine that serves this workspace, then retry.",
  },
  unreachable: {
    title: "Can't reach the workspace runtime",
    detail: "The relay or runtime is temporarily unreachable. This usually clears on its own.",
  },
  "still-provisioning": {
    title: "Workspace is still starting",
    detail: "The sandbox is taking longer than usual to prepare. Nothing failed — retry to keep waiting.",
  },
  failed: {
    title: "Workspace failed to start",
    detail: "Something went wrong preparing the workspace runtime. Review the details and retry.",
  },
  // `forbidden` is rendered by WorkspaceAccessDeniedView, never here.
  forbidden: {
    title: "You don't have access to this workspace",
    detail: "This workspace belongs to another account, or your access was removed.",
  },
}

// Terminal "still-offline" surface for the transient reasons (no-host /
// unreachable / failed). Reuses the same visual language as CloudStartupView's
// error state; offers Retry only when the failure is NOT terminal.
export function WorkspaceOfflineView(props: {
  reason: WorkspaceOfflineReason
  terminal?: boolean
  err?: string
  onRetry?: () => void
}) {
  const copy = () => OFFLINE_COPY[props.reason] ?? OFFLINE_COPY.failed
  const extraError = () => {
    const err = props.err?.trim()
    if (!err) return
    if (err === copy().title || err === copy().detail) return
    if (err.includes(copy().detail) || err.startsWith(`${copy().title}.`)) return
    return err
  }
  // Same column as the connecting pipeline it replaces (WorkspaceStateShell), so
  // a failed connect reads as the same pane changing state rather than a
  // different screen: the eyebrow, title and detail stay where they were and the
  // raw error takes the slot the live log had.
  return (
    <WorkspaceStateShell
      component="workspace-offline"
      testId="workspace-offline"
      tone="critical"
      eyebrow="Workspace runtime"
      title={copy().title}
      detail={copy().detail}
      actions={
        <Show when={!props.terminal && props.onRetry}>
          <WorkspaceStateButton testId="workspace-offline-retry" onClick={() => props.onRetry?.()}>
            Retry
          </WorkspaceStateButton>
        </Show>
      }
    >
      <Show when={extraError()}>
        {(err) => (
          <WorkspaceStateNote tone="critical">
            <Icon name="warning" size="small" class="translate-y-px shrink-0 text-icon-base" />
            <span class="min-w-0 break-words font-mono text-xs leading-5 text-text-strong">{err()}</span>
          </WorkspaceStateNote>
        )}
      </Show>
    </WorkspaceStateShell>
  )
}

/**
 * Should an unreachable workspace still render its surface, because the thing
 * being viewed lives centrally rather than on the runtime?
 *
 * True only for an EXISTING cloud session. Those sync back to the central
 * control plane (Convex `session_history`/`session_messages`), so a stopped or
 * destroyed sandbox does not take the transcript with it — the reads route to
 * the control plane. Blocking the surface hid history the server was still
 * serving, which is the bug this branch fixes.
 *
 * Excluded, each because there is genuinely nothing to read centrally:
 *  - a DRAFT (no sessionId, or the `"new"` route sentinel): it has no stored
 *    history and its first send needs a live runtime, so the offline panel with
 *    its Retry is the honest surface.
 *  - user-hosted: the owner's machine is the only store.
 *  - `forbidden`: no access means no read, for any kind.
 */
function hasCentralHistory(input: {
  kind: WorkspaceConnectionKind
  reason: WorkspaceOfflineReason
  sessionId?: string
}) {
  if (input.reason === "forbidden") return false
  if (!input.sessionId || input.sessionId === "new") return false
  return input.kind === "cloud"
}

export function WorkspaceGate(
  props: ParentProps<{
    workspaceId: string | undefined
    kind: WorkspaceConnectionKind
    directory?: string
    serverUrl?: string
    request?: typeof fetch
    relayRequest?: typeof fetch
    connectingFallback?: JSX.Element
    /**
     * The EXISTING session this gate wraps, when there is one. Absent for a
     * draft. Only an existing cloud session has central history worth rendering
     * a dead workspace's surface for — see `hasCentralHistory`.
     */
    sessionId?: string
    /** Optional access-denied escape hatch (forbidden branch). */
    onGoToWorkspaces?: () => void
  }>,
) {
  const events = useClaxedoEventsOptional()

  // Acquire (ref-counted) for as long as this gate is mounted. A gate with no
  // workspaceId has nothing to connect to and renders its children directly
  // (central/no-backing surface) — same as a local workspace.
  // Fresh options object per run: any of these changing must re-acquire, exactly
  // as the same-scope form did.
  createEffect(
    () => {
      if (!props.workspaceId) return
      return {
        workspaceId: props.workspaceId,
        kind: props.kind,
        ...(props.directory ? { directory: props.directory } : {}),
        ...(props.serverUrl ? { baseUrl: props.serverUrl } : {}),
        ...(props.request ? { request: props.request } : {}),
        ...(props.relayRequest ? { relayRequest: props.relayRequest } : {}),
        ...(events ? { events } : {}),
      }
    },
    (options) => {
      if (!options) return
      const handle = acquireWorkspaceConnection(options)
      return () => handle.release()
    },
  )

  const conn = () => workspaceConnection(props.workspaceId)
  const offline = () => workspaceOffline(props.workspaceId)

  return (
    <Show when={props.workspaceId} fallback={props.children}>
      <Switch>
        <Match when={conn()?.status === "ready"}>{props.children}</Match>
        <Match when={offline() === "forbidden"}>
          <WorkspaceAccessDeniedView onGoToWorkspaces={props.onGoToWorkspaces} />
        </Match>
        {/* An EXISTING cloud session's history lives in the control plane, so a
            dead sandbox renders the surface instead of the offline panel: the
            session reads resolve centrally and the transcript loads. Anything
            needing the live runtime (sending a turn, the terminal) stays gated
            by its own readiness checks, which still see this workspace as not
            ready. Drafts and user-hosted keep the offline panel. */}
        <Match
          when={offline() && hasCentralHistory({ kind: props.kind, reason: offline()!, sessionId: props.sessionId })}
        >
          {props.children}
        </Match>
        <Match when={offline()}>
          {(reason) => (
            <WorkspaceOfflineView
              reason={reason()}
              terminal={conn()?.terminal}
              err={conn()?.err}
              onRetry={() => retryWorkspaceConnection(props.workspaceId)}
            />
          )}
        </Match>
        <Match when={true}>
          {/* connecting | reconnecting */}
          {props.connectingFallback ?? (
            <CloudStartupView
              variant={props.kind === "user-hosted" ? "user-hosted" : "cloud"}
              status={conn()?.phase ?? "connecting_workspace"}
              err={conn()?.err}
              logs={conn()?.logs ?? []}
            />
          )}
        </Match>
      </Switch>
    </Show>
  )
}
