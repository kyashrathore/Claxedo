import { Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { WebSocketCloseError } from "@claxedo/terminal/terminal-connection"
import { requestTerminalFitOnPaneChange } from "../terminal/terminal-fit"
import { aliasTerminalSessionPreview, loadTerminalSessionPreview } from "../utils/terminal-session-preview"
import { aliasTerminalLogSummary } from "../utils/terminal-log-summary"
import { pendingRecovery, resolveRecovery, trackRecovery } from "../terminal/pane-terminal-recovery"
import { getClaxedoServerUrl } from "../../utils/api"
import { usePlatform } from "@claxedo/context/platform"
import { resolveWorkspaceRuntime } from "../../cloud/runtime/workspace-runtime-store"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { SessionPaneScope } from "../components/session-pane-scope"
import { shouldMountTerminalPane } from "./terminal-content-policy"
import { workspaceTerminalRoute } from "../../shell/identity/route"

const recoveryAlias = new Map<string, { id: string; at: number }>()
const TERMINAL_ACTIVATION_DELAY_MS = 120

export function TerminalContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const directory = () => props.meta.directory ?? props.meta.content?.directory
  const sessionRef = () => props.meta.content?.sessionRef

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
          <TerminalContentInner meta={props.meta} ctx={props.ctx} directory={() => dir()} />
        </SessionPaneScope>
      )}
    </Show>
  )
}

function TerminalContentInner(props: { meta: ContentMeta; ctx: PaneCtx; directory: () => string }) {
  const state = useClaxedoState()
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
    if (location.pathname !== workspaceTerminalRoute(dir, oldId)) return
    navigate(workspaceTerminalRoute(dir, newId), { replace: true })
  }

  const [realPtyId, setRealPtyId] = createSignal(
    terminalId()?.startsWith("pending-") ? undefined : terminalId(),
  )
  const [createError, setCreateError] = createSignal<string | undefined>()
  const [retryNonce, setRetryNonce] = createSignal(0)
  const [activated, setActivated] = createSignal(false)
  let activationTimer: ReturnType<typeof setTimeout> | undefined
  let createStarted = false
  let disposed = false

  onCleanup(() => {
    disposed = true
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
        setRealPtyId(recovered)
        aliasTerminalSessionPreview(tid, recovered)
        aliasTerminalLogSummary(tid, recovered)
        state.terminal.replaceId(tid, recovered)
        state.meta.patch(props.meta.id, {
          terminalId: recovered,
          content: {
            ...props.meta.content,
            type: "terminal",
            directory: dir,
            terminalId: recovered,
            title: title(),
          },
        })
        replaceTerminalRoute(tid, recovered, dir)
        requestTerminalFitOnPaneChange()
        return
      }
      const pending = pendingRecovery(tid)
      if (pending) {
        void pending.then((newId) => {
          if (!newId || disposed) return
          setRealPtyId(newId)
          aliasTerminalSessionPreview(tid, newId)
          aliasTerminalLogSummary(tid, newId)
          state.terminal.replaceId(tid, newId)
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
          replaceTerminalRoute(tid, newId, dir)
          requestTerminalFitOnPaneChange()
        })
        return
      }
      terminal.ensure({
        id: tid,
        title: title(),
        cwd: dir,
      })
      setRealPtyId(tid)
      return
    }

    if (createStarted) return
    const queued = state.terminal.peekCreateForContent(props.meta.id)

    createStarted = true
    const consumed = queued ? state.terminal.consumeCreateForContent(props.meta.id) : undefined
    const nextCommand = consumed?.command ?? command()
    const nextTitle = consumed?.title ?? title()
    const previousPtyId = consumed?.previousPtyId

    setCreateError(undefined)
    const created = terminal.new(nextCommand, nextTitle, previousPtyId)
    if (!created) {
      createStarted = false
      setCreateError("Terminal context is not available for this workspace.")
      return
    }

    void created
      .then((createdId) => {
        if (!createdId) {
          createStarted = false
          setCreateError("Claxedo did not return a terminal id.")
          return
        }
        if (disposed) return
        setRealPtyId(createdId)
        state.terminal.own(props.meta.id, createdId)
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
        replaceTerminalRoute(tid, createdId, dir)
        requestTerminalFitOnPaneChange()
      })
      .catch((error) => {
        createStarted = false
        setCreateError(error instanceof Error ? error.message : "Terminal failed to start.")
      })
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
  createResource(realPtyId, (id) =>
    loadTerminalSessionPreview(claxedoServerUrl, id, {
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
    }),
  )

  const handleConnectError = async (error: unknown) => {
    const id = realPtyId()
    if (!id) return
    if (error instanceof WebSocketCloseError && error.code === 1008) {
      let newId: string | undefined
      try {
        newId = await trackRecovery(recoveryAlias, id, () => terminal.clone(id) ?? Promise.resolve(undefined))
      } catch {
        // clone failed; keep the existing terminal visible.
      }
      const dir = directory()
      if (!newId || disposed || !dir) return
      setRealPtyId(newId)
      aliasTerminalSessionPreview(id, newId)
      aliasTerminalLogSummary(id, newId)
      state.terminal.replaceId(id, newId)
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
      replaceTerminalRoute(id, newId, dir)
      requestTerminalFitOnPaneChange()
    }
  }

  return (
    <Show
      when={shouldMountTerminalPane({
        visible: props.ctx.isVisible(),
        ptyReady: !!pty(),
        activated: activated(),
      }) ? pty() : undefined}
      keyed
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
      {(pty) => (
        <div
          data-testid="terminal-pane"
          data-terminal-id={pty.id}
          data-content-id={props.meta.id}
          class="flex-1 min-h-0 h-full w-full overflow-hidden"
        >
          <Terminal
            pty={pty}
            data-testid="terminal-xterm-host"
            autoFocus={false}
            onCleanup={terminal.update}
            onUpdate={terminal.update}
            onConnectError={handleConnectError}
            onAgentInterrupt={() => {
              const id = realPtyId()
              if (!id) return
              if (!state.terminal.isTracked(id)) return
              if (state.terminal.agentStatus(id) === "idle") return

              batch(() => {
                state.terminal.setAgentStatus(id, "idle")
              })
            }}
            onSplitVertical={() => requestTerminalFitOnPaneChange()}
            onSplitHorizontal={() => requestTerminalFitOnPaneChange()}
            onFileLinkOpen={(filePath) => {
              const workspaceDir = directory()
              if (!filePath.startsWith("/") || filePath.startsWith(workspaceDir + "/") || filePath === workspaceDir) {
                state.workspacePanel.open({
                  workspaceDir,
                  targetPaneId: props.ctx.paneId,
                  navigator: "files",
                  focus: { kind: "file", path: filePath, intent: "tab" },
                })
              }
            }}
          />
        </div>
      )}
    </Show>
  )
}
