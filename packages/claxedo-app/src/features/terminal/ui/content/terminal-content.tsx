import { Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { RoleGuardedTerminal } from "../../core/role-guarded-terminal"
import { useTerminal } from "@/features/terminal/providers/provider"
import { WebSocketCloseError } from "@/features/terminal/core/terminal-connection"
import { requestTerminalFitOnPaneChange } from "../../workbench/terminal-fit"
import { aliasTerminalSessionPreview, loadTerminalSessionPreview } from "../../lib/terminal-session-preview"
import { aliasTerminalLogSummary } from "../../lib/terminal-log-summary"
import { pendingRecovery, resolveRecovery, trackRecovery } from "../../workbench/pane-terminal-recovery"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { createTransport, centralTransportForServer } from "@/platform/runtime/transport"
import { terminalPtyApiPath } from "@/features/terminal/core/terminal-connection"
import {
  SessionPaneScope,
  TerminalNewView,
  useClaxedoState,
  useSDK,
  type ContentMeta,
  type PaneCtx,
} from "@/features/terminal/app-ports"
import { NEW_TERMINAL_ID, PENDING_TERMINAL_PREFIX } from "../../core/terminal-surface-id"
import { shouldMountTerminalPane, pickAdoptedPty } from "./terminal-content-policy"
import { workspaceTerminalRoute } from "@/platform/identity/route"
import { resolveWorkspaceFileFocus } from "@/platform/files/workspace-file-focus"
import { terminalAgentStatusFromEventType } from "../../core/terminal-agent-status"

/** See the note on the same alias in `app/workbench/terminal/terminal-new-view.tsx`. */
type WorkspaceDirectoryRef = string

const recoveryAlias = new Map<string, { id: string; at: number }>()
const TERMINAL_ACTIVATION_DELAY_MS = 120

export function TerminalContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const directory = () => props.meta.directory ?? props.meta.content?.directory
  const sessionRef = () => props.meta.content?.sessionRef
  const terminalId = () => props.meta.terminalId ?? props.meta.content?.terminalId

  return (
    <Show
      when={directory()}
      fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
    >
      {(dir) => (
        <SessionPaneScope
          directory={dir()}
          sessionRef={sessionRef}
          active={props.ctx.isVisible}
          sessionId={() => props.meta.sessionId}
          paneId={() => props.ctx.paneId}
          surfaceId={() => props.meta.id}
        >
          {/* The branch belongs INSIDE the pane scope, not around it. The scope
              is what provides the directory-scoped SDK/server/layout contexts,
              and the creator needs them (its placement chips read the project
              inventory through them). It is `TerminalContentInner` that starts a
              pty on mount, so swapping only the inner component is what keeps a
              `new` surface from spawning one. */}
          <Show
            when={terminalId() !== NEW_TERMINAL_ID}
            fallback={<TerminalNewSurface meta={props.meta} ctx={props.ctx} directory={() => dir()} />}
          >
            <TerminalContentInner meta={props.meta} ctx={props.ctx} directory={() => dir()} />
          </Show>
        </SessionPaneScope>
      )}
    </Show>
  )
}

/**
 * A terminal surface that has not chosen a workspace yet. It owns the two
 * transitions the creator itself cannot perform, because both need this
 * surface's content id: re-pointing at another directory, and becoming a real
 * terminal in place (rather than opening a second tab and orphaning this one).
 */
function TerminalNewSurface(props: {
  meta: ContentMeta
  ctx: PaneCtx
  directory: () => string
}) {
  const state = useClaxedoState()
  const navigate = useNavigate()

  const retarget = (directory: WorkspaceDirectoryRef) => {
    state.meta.patch(props.meta.id, {
      directory,
      content: {
        ...props.meta.content,
        type: "terminal",
        directory,
        terminalId: NEW_TERMINAL_ID,
        workspaceRouteId: undefined,
      },
    })
  }

  const launch = (input: { directory: WorkspaceDirectoryRef; workspaceId: string; command?: string; title?: string }) => {
    const pendingId = `${PENDING_TERMINAL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const title = input.title || "Terminal"
    // Managed (signed) PTY create requires sessionId. Opening the New Terminal
    // surface steals focus from the session that owned the Shell click, so read
    // any open session in this workspace rather than the now-focused creator.
    const sessionId = props.meta.sessionId
      ?? state.meta.all().find((meta) => {
        if (!meta.sessionId) return false
        if (meta.content?.type === "terminal") return false
        const routeId = meta.content?.workspaceRouteId
        if (routeId && routeId === input.workspaceId) return true
        return (meta.directory ?? meta.content?.directory) === input.directory
      })?.sessionId
    batch(() => {
      state.meta.patch(props.meta.id, {
        directory: input.directory,
        terminalId: pendingId,
        ...(sessionId ? { sessionId } : {}),
        content: {
          ...props.meta.content,
          type: "terminal",
          directory: input.directory,
          terminalId: pendingId,
          title,
          workspaceRouteId: input.workspaceId,
          ...(input.command ? { command: input.command } : {}),
        },
      })
      state.terminal.queueCreateForContent(
        props.meta.id,
        input.directory,
        input.command,
        input.title,
        props.ctx.paneId,
      )
    })
    // Route to the pending id for the same reason `handleNewTerminal` does: it
    // is also what lets TerminalContentInner rewrite the URL when the real pty
    // id arrives (its swap is a no-op unless the route already points at the
    // pending one).
    navigate(workspaceTerminalRoute(input.workspaceId, pendingId))
  }

  return (
    <TerminalNewView
      directory={props.directory()}
      workspaceId={props.meta.content?.workspaceRouteId}
      onLaunch={launch}
      onRetarget={retarget}
    />
  )
}

function TerminalContentInner(props: {
  meta: ContentMeta
  ctx: PaneCtx
  directory: () => string
}) {
  const state = useClaxedoState()
  const sdk = useSDK()
  const terminal = useTerminal()
  const platform = usePlatform()
  const location = useLocation()
  const navigate = useNavigate()
  const claxedoServerUrl = getClaxedoServerUrl()

  const directory = props.directory
  const title = () => props.meta.content?.title || "Terminal"
  const terminalId = () => props.meta.terminalId ?? props.meta.content?.terminalId
  const command = () => props.meta.content?.command
  const replaceTerminalRoute = (oldId: string, newId: string, dir: string) => {
    const workspaceId = props.meta.content?.workspaceRouteId ?? sdk.workspaceId
    if (!workspaceId || location.pathname !== workspaceTerminalRoute(workspaceId, oldId)) return
    const next = workspaceTerminalRoute(workspaceId, newId)
    // Pending→real upgrades happen while the terminal socket is opening.
    // Solid Router navigation remounts the pane and drops the live PTY stream;
    // a quiet history replace keeps the URL aligned without tearing down xterm.
    if (oldId.startsWith("pending-")) {
      window.history.replaceState(window.history.state, "", next)
      return
    }
    navigate(next, { replace: true })
  }

  const [realPtyId, setRealPtyId] = createSignal(
    terminalId()?.startsWith("pending-") ? undefined : terminalId(),
  )

  /**
   * Adopt a replacement pty id after a recovery/clone: point the live signal,
   * carry the session-preview + log-summary caches forward under the new id,
   * rewrite the terminal id in workbench state + meta, swap the route, and
   * refit. Shared by the recovered-alias branch, the pending-recovery
   * resolution, and the 1008-close reconnect path so the swap stays identical.
   */
  const adoptTerminalId = (oldId: string, newId: string, dir: string) => {
    setRealPtyId(newId)
    aliasTerminalSessionPreview(oldId, newId)
    aliasTerminalLogSummary(oldId, newId)
    state.terminal.replaceId(oldId, newId)
    state.meta.patch(props.meta.id, {
      terminalId: newId,
      content: {
        ...props.meta.content,
        type: "terminal",
        directory: dir,
        terminalId: newId,
        title: title(),
      },
    })
    replaceTerminalRoute(oldId, newId, dir)
    requestTerminalFitOnPaneChange()
  }
  const [createError, setCreateError] = createSignal<string | undefined>()
  const [connected, setConnected] = createSignal(false)
  const [retryNonce, setRetryNonce] = createSignal(0)
  const [activated, setActivated] = createSignal(false)
  let activationTimer: ReturnType<typeof setTimeout> | undefined
  let createStarted = false
  let pendingCreateSettled = false
  let ptyIdsBeforeCreate: Set<string> | undefined
  let pendingPollTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const stopPendingPoll = () => {
    if (pendingPollTimer) {
      clearInterval(pendingPollTimer)
      pendingPollTimer = undefined
    }
  }

  const resolvePollWorkspaceId = async (dir: string) => {
    const routed = props.meta.content?.workspaceRouteId ?? sdk.workspaceId
    if (routed) return routed
    const workspace = await resolveWorkspaceRuntime({
      baseUrl: claxedoServerUrl,
      request: authFetch,
      directory: dir,
    })
    return workspace?.kind === "local" ? undefined : workspace?.workspaceId
  }

  const claimedPtyIds = () => {
    const claimed = new Set<string>()
    for (const meta of state.meta.all()) {
      if (meta.type !== "terminal" || meta.id === props.meta.id) continue
      for (const id of state.terminal.ownedIds(meta.id)) claimed.add(id)
      const tid = meta.terminalId ?? meta.content?.terminalId
      if (tid?.startsWith("pty_")) claimed.add(tid)
    }
    return claimed
  }

  const pollPendingCreateFromServer = (pendingId: string, dir: string, nextTitle: string, nextCommand?: string) => {
    const pollOnce = () => {
      if (pendingCreateSettled || disposed) return
      void (async () => {
        const sessionId = props.meta.sessionId
        const before = ptyIdsBeforeCreate
        if (!before) return
        const workspaceId = await resolvePollWorkspaceId(dir)
        if (!workspaceId) return
        const transport = createTransport({
          placement: {
            workspaceId,
            hosting: "workspace",
            transport: centralTransportForServer(claxedoServerUrl) !== "loopback" ? "workspace-relay" : "loopback",
          },
          serverUrl: claxedoServerUrl,
          directory: workspaceId ? undefined : dir,
          request: authFetch,
          resolveWorkspaceRuntime: async ({ directory }) => {
            const resolved = await resolveWorkspaceRuntime({
              baseUrl: claxedoServerUrl,
              request: authFetch,
              directory,
            })
            if (!resolved?.kind) return null
            return { kind: resolved.kind, workspaceId: resolved.workspaceId }
          },
        })
        // List endpoint is `/api/wr/pty` (no trailing slash). A trailing `/`
        // is routed as an empty pty id and 404s on the signed relay path.
        const res = await transport.fetch(
          terminalPtyApiPath(workspaceId ? { workspaceId } : { directory: dir }),
        )
        if (!res.ok) return
        const body = await res.json()
        const rows = Array.isArray(body) ? body : []
        const adopted = pickAdoptedPty(rows, before, sessionId, claimedPtyIds())
        if (!adopted) return
        completePendingCreate(pendingId, adopted.id, dir, nextTitle, nextCommand)
      })().catch(() => undefined)
    }

    stopPendingPoll()
    pollOnce()
    pendingPollTimer = setInterval(pollOnce, 400)
  }

  const completePendingCreate = (
    pendingId: string,
    createdId: string,
    dir: string,
    nextTitle: string,
    nextCommand?: string,
  ) => {
    if (pendingCreateSettled) return
    pendingCreateSettled = true
    stopPendingPoll()
    setCreateError(undefined)
    terminal.ensure({
      id: createdId,
      ...(props.meta.sessionId ? { sessionId: props.meta.sessionId } : {}),
      title: nextTitle || "Terminal",
      cwd: dir,
      ...(nextCommand ? { initialCommand: nextCommand } : {}),
    })
    state.terminal.own(props.meta.id, createdId)
    batch(() => {
      state.meta.patch(props.meta.id, {
        terminalId: createdId,
        content: {
          ...props.meta.content,
          type: "terminal",
          directory: dir,
          terminalId: createdId,
          title: nextTitle || "Terminal",
          ...(nextCommand ? { command: nextCommand } : {}),
        },
      })
      if (disposed) return
      replaceTerminalRoute(pendingId, createdId, dir)
      setRealPtyId(createdId)
    })
    if (!disposed) requestTerminalFitOnPaneChange()
  }

  onCleanup(() => {
    disposed = true
    stopPendingPoll()
    if (activationTimer) clearTimeout(activationTimer)
  })

  createEffect(() => {
    const id = realPtyId()
    if (!id) return
    const nextTitle = title()
    const current = terminal.all().find((p) => p.id === id)
    if (current?.title === nextTitle) return
    terminal.update({ id, title: nextTitle })
  })

  createEffect(() => {
    const tid = terminalId()
    const dir = directory()
    retryNonce()
    if (!tid || !dir) return

    if (!tid.startsWith("pending-")) {
      const recovered = resolveRecovery(recoveryAlias, tid)
      if (recovered !== tid) {
        adoptTerminalId(tid, recovered, dir)
        return
      }
      const pending = pendingRecovery(tid)
      if (pending) {
        void pending.then((newId) => {
          if (!newId || disposed) return
          adoptTerminalId(tid, newId, dir)
        })
        return
      }
      if (!terminal.all().some((p) => p.id === tid)) {
        terminal.ensure({
          id: tid,
          ...(props.meta.sessionId ? { sessionId: props.meta.sessionId } : {}),
          title: title(),
          cwd: dir,
        })
      }
      setRealPtyId(tid)
      return
    }

    if (createStarted) return
    const queued = state.terminal.peekCreateForContent(props.meta.id)

    createStarted = true
    pendingCreateSettled = false
    ptyIdsBeforeCreate = new Set(terminal.all().map((p) => p.id))
    const consumed = queued ? state.terminal.consumeCreateForContent(props.meta.id) : undefined
    const nextCommand = consumed?.command ?? command()
    const nextTitle = consumed?.title ?? title()
    const previousPtyId = consumed?.previousPtyId

    setCreateError(undefined)
    const created = terminal.new({
      initialCommand: nextCommand,
      title: nextTitle,
      previousPtyId,
      sessionId: props.meta.sessionId,
    })
    if (!created) {
      createStarted = false
      setCreateError("Terminal context is not available for this workspace.")
      return
    }

    pollPendingCreateFromServer(tid, dir, nextTitle || "Terminal", nextCommand)

    void created
      .then((createdId) => {
        if (!createdId) {
          createStarted = false
          pendingCreateSettled = false
          setCreateError("Claxedo did not return a terminal id.")
          return
        }
        stopPendingPoll()
        completePendingCreate(tid, createdId, dir, nextTitle || "Terminal", nextCommand)
      })
      .catch((error) => {
        if (pendingCreateSettled) return
        setCreateError(error instanceof Error ? error.message : "Terminal failed to start.")
      })
  })

  createEffect(() => {
    const tid = terminalId()
    const dir = directory()
    if (!tid?.startsWith("pending-") || !dir || !createStarted || pendingCreateSettled) return
    const before = ptyIdsBeforeCreate
    if (!before) return
    const adopted = pickAdoptedPty(terminal.all(), before, props.meta.sessionId, claimedPtyIds())
    if (!adopted) return
    stopPendingPoll()
    completePendingCreate(tid, adopted.id, dir, title(), command())
  })

  const pty = createMemo(() => {
    const id = realPtyId()
    if (!id) return undefined
    return terminal.all().find((p) => p.id === id)
  })
  createEffect(() => {
    if (activated()) return
    if (!props.ctx.isVisible() || !pty()) {
      if (activationTimer) {
        clearTimeout(activationTimer)
        activationTimer = undefined
      }
      return
    }
    if (activationTimer) return
    activationTimer = setTimeout(() => {
      activationTimer = undefined
      if (disposed || !props.ctx.isVisible() || !pty()) return
      setActivated(true)
    }, TERMINAL_ACTIVATION_DELAY_MS)
  })
  // When an already-activated pane becomes visible again (e.g. user switches
  // back to it via sidebar), xterm.js retains its size from when it was
  // hidden — which can be effectively zero. Without an explicit refit it
  // renders into the new pane at the wrong dimensions, leaving a blank or
  // tiny terminal until the next resize event. Dispatch the fit signal on
  // every visible-edge transition so the xterm viewport matches the pane.
  let wasVisible = false
  createEffect(() => {
    const visible = props.ctx.isVisible()
    if (visible && !wasVisible && activated()) requestTerminalFitOnPaneChange()
    wasVisible = visible
  })
  createResource(realPtyId, async (id) => {
    const preview = await loadTerminalSessionPreview(claxedoServerUrl, id, {
      request: platform.fetch,
      directory: directory(),
      resolveWorkspaceRuntime: async ({ directory }) => {
        const workspace = await resolveWorkspaceRuntime({
          baseUrl: claxedoServerUrl,
          request: platform.fetch,
          directory,
        })
        if (!workspace?.kind) return null
        return {
          kind: workspace.kind,
          workspaceId: workspace.workspaceId,
        }
      },
    })
    if (!id || !preview || preview.terminalId !== id) return
    const status = terminalAgentStatusFromEventType(preview.eventType)
    if (!status || state.terminal.isTracked(id)) return
    state.terminal.setAgentStatus(id, status)
  })

  const handleConnectError = async (error: unknown) => {
    setConnected(false)
    const id = realPtyId()
    if (!id) return
    if (error instanceof WebSocketCloseError && error.code === 1008) {
      let newId: string | undefined
      try {
        newId = await trackRecovery(
          recoveryAlias,
          id,
          () => terminal.clone(id, props.meta.sessionId) ?? Promise.resolve(undefined),
        )
      } catch {
        // clone failed; keep the existing terminal visible.
      }
      const dir = directory()
      if (!newId || disposed || !dir) return
      adoptTerminalId(id, newId, dir)
    }
  }

  // Key on the stable pty id string (not the LocalPTY object). Solid 1.9
  // keyed-on-object remounts whenever ensure/update replaces row identity and
  // tears down the live WebSocket before firstByte. Mount only after
  // `activated` so pending→real route adoption settles first.
  return (
    <Show
      keyed
      when={shouldMountTerminalPane({
        visible: props.ctx.isVisible(),
        ptyReady: !!pty(),
        activated: activated(),
      })
        ? realPtyId()
        : undefined}
      fallback={
        <Show
          when={createError()}
          fallback={
            <div class="flex items-center justify-center h-full text-text-weak">
              <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
            </div>
          }
        >
          {(message) => (
            <div class="flex h-full items-center justify-center px-4 text-center">
              <div class="max-w-sm space-y-3">
                <div class="text-sm font-medium text-text-strong">Terminal failed to start</div>
                <div class="text-xs text-text-weak break-words">{message()}</div>
                <button
                  type="button"
                  class="h-10 rounded-md border border-border-weak-base px-4 text-sm text-text-base hover:bg-surface-base-hover active:scale-[0.96]"
                  onClick={() => {
                    createStarted = false
                    setCreateError(undefined)
                    setRetryNonce((value) => value + 1)
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </Show>
      }
    >
      {(id) => {
        const current = () => pty()
        return (
          <Show when={!!current()}>
            <div
              data-testid="terminal-pane"
              data-terminal-id={id}
              data-content-id={props.meta.id}
              data-terminal-connected={connected() ? "true" : "false"}
              class="flex-1 min-h-0 h-full w-full overflow-hidden"
            >
              <RoleGuardedTerminal
                pty={current()!}
                data-testid="terminal-xterm-host"
                autoFocus={false}
                onConnect={() => setConnected(true)}
                onCleanup={terminal.update}
                onUpdate={terminal.update}
                onConnectError={handleConnectError}
                onAgentInterrupt={() => {
                  if (!state.terminal.isTracked(id)) return
                  if (state.terminal.agentStatus(id) === "idle") return

                  batch(() => {
                    state.terminal.setAgentStatus(id, "idle")
                  })
                }}
                onSplitVertical={() => requestTerminalFitOnPaneChange()}
                onSplitHorizontal={() => requestTerminalFitOnPaneChange()}
                onFileLinkOpen={(filePath, line, col) => {
                  const workspaceDir = directory()
                  const target = resolveWorkspaceFileFocus(filePath, workspaceDir)
                  if (!target) return
                  // No `navigator: "files"`: the tree drawer would slide over the
                  // file tab this click opens.
                  state.workspacePanel.open({
                    workspaceDir,
                    targetPaneId: props.ctx.paneId,
                    focus: {
                      kind: "file",
                      path: target.path,
                      intent: "tab",
                      line: line ?? target.line,
                      col: col ?? target.col,
                    },
                  })
                }}
              />
            </div>
          </Show>
        )
      }}
    </Show>
  )
}
