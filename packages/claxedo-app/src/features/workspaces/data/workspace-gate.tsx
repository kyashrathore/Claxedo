import { Match, Show, Switch, createEffect, onCleanup, type JSX, type ParentProps } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { CloudStartupView, WorkspaceAccessDeniedView, useClaxedoEventsOptional } from "@/features/workspaces/app-ports"
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
    detail:
      "Start it by running `claxedo up` on the machine that serves this workspace, then retry.",
  },
  unreachable: {
    title: "Can't reach the workspace runtime",
    detail: "The relay or runtime is temporarily unreachable. This usually clears on its own.",
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
  return (
    <div data-component="workspace-offline" data-testid="workspace-offline" class="flex size-full items-center justify-center px-6 py-10">
      <div class="flex w-full max-w-[460px] flex-col items-center text-center">
        <Icon name="warning" size="large" class="text-text-on-critical-base" />
        <div class="mt-3 text-[18px] font-medium leading-6 text-text-strong">{copy().title}</div>
        <div class="mt-1 max-w-[420px] text-13-regular text-text-weak">{copy().detail}</div>
        <Show when={extraError()}>
          {(err) => (
            <div class="mt-3 max-w-[420px] text-12-regular text-text-on-critical-base/80 break-words">{err()}</div>
          )}
        </Show>
        <Show when={!props.terminal && props.onRetry}>
          <div class="mt-5 flex justify-center">
            <button
              type="button"
              data-testid="workspace-offline-retry"
              class="inline-flex h-8 items-center rounded-md border border-border-weak-base/55 bg-background-base px-3 text-12-regular text-text-base hover:bg-surface-base-hover/40"
              onClick={() => props.onRetry?.()}
            >
              Retry
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
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
    /** Optional access-denied escape hatch (forbidden branch). */
    onGoToWorkspaces?: () => void
  }>,
) {
  const events = useClaxedoEventsOptional()

  // Acquire (ref-counted) for as long as this gate is mounted. A gate with no
  // workspaceId has nothing to connect to and renders its children directly
  // (central/no-backing surface) — same as a local workspace.
  createEffect(() => {
    if (!props.workspaceId) return
    const handle = acquireWorkspaceConnection({
      workspaceId: props.workspaceId,
      kind: props.kind,
      ...(props.directory ? { directory: props.directory } : {}),
      ...(props.serverUrl ? { baseUrl: props.serverUrl } : {}),
      ...(props.request ? { request: props.request } : {}),
      ...(props.relayRequest ? { relayRequest: props.relayRequest } : {}),
      ...(events ? { events } : {}),
    })
    onCleanup(() => handle.release())
  })

  const conn = () => workspaceConnection(props.workspaceId)
  const offline = () => workspaceOffline(props.workspaceId)

  return (
    <Show when={props.workspaceId} fallback={props.children}>
      <Switch>
        <Match when={conn()?.status === "ready"}>{props.children}</Match>
        <Match when={offline() === "forbidden"}>
          <WorkspaceAccessDeniedView onGoToWorkspaces={props.onGoToWorkspaces} />
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
