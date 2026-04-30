import { Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { WebSocketCloseError } from "../../overrides/components/terminal-connection"
import { requestTerminalFitOnPaneChange } from "../terminal/terminal-fit"
import { aliasTerminalSessionPreview, loadTerminalSessionPreview } from "../utils/terminal-session-preview"
import { resolveRecovery, trackRecovery } from "../terminal/pane-terminal-recovery"
import { getClaxedoServerUrl } from "../../utils/api"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"

const recoveryAlias = new Map<string, { id: string; at: number }>()
const recoveryInflight = new Map<string, Promise<string | undefined>>()

export function TerminalContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const directory = () => props.meta.directory ?? props.meta.content?.directory

  return (
    <Show
      when={directory()}
      fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
    >
      {(dir) => (
        <DirectoryScope directory={dir()}>
          <TerminalContentInner meta={props.meta} ctx={props.ctx} directory={() => dir()} />
        </DirectoryScope>
      )}
    </Show>
  )
}

function TerminalContentInner(props: { meta: ContentMeta; ctx: PaneCtx; directory: () => string }) {
  const state = useClaxedoState()
  const terminal = useTerminal()
  const claxedoServerUrl = getClaxedoServerUrl()

  const directory = props.directory
  const title = () => props.meta.content?.title || "Terminal"
  const terminalId = () => props.meta.terminalId ?? props.meta.content?.terminalId
  const command = () => props.meta.content?.command

  const [realPtyId, setRealPtyId] = createSignal<string | undefined>(
    terminalId()?.startsWith("pending-") ? undefined : terminalId(),
  )
  let createStarted = false
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    const tid = terminalId()
    const dir = directory()
    if (!tid || !dir) return

    if (!tid.startsWith("pending-")) {
      const recovered = resolveRecovery(recoveryAlias, tid)
      if (recovered !== tid) {
        setRealPtyId(recovered)
        aliasTerminalSessionPreview(tid, recovered)
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
        requestTerminalFitOnPaneChange()
        return
      }
      const pending = recoveryInflight.get(tid)
      if (pending) {
        void pending.then((newId) => {
          if (!newId || disposed) return
          setRealPtyId(newId)
          aliasTerminalSessionPreview(tid, newId)
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
          requestTerminalFitOnPaneChange()
        })
        return
      }
      terminal.ensure({
        id: tid,
        title: title(),
        cwd: dir,
        ...(command() ? { initialCommand: command() } : {}),
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

    const created = terminal.new(nextCommand, nextTitle, previousPtyId)
    if (!created) {
      createStarted = false
      return
    }

    void created
      .then((createdId) => {
        if (!createdId) {
          createStarted = false
          return
        }
        if (disposed) return
        setRealPtyId(createdId)
        state.terminal.own(props.meta.id, createdId)
        state.meta.patch(props.meta.id, {
          terminalId: createdId,
          content: {
            type: "terminal",
            directory: dir,
            terminalId: createdId,
            title: nextTitle || "Terminal",
            ...(nextCommand ? { command: nextCommand } : {}),
          },
        })
        requestTerminalFitOnPaneChange()
      })
      .catch(() => {
        createStarted = false
      })
  })

  const pty = createMemo(() => {
    const id = realPtyId()
    if (!id) return undefined
    return terminal.all().find((p) => p.id === id)
  })
  const [agentSession] = createResource(realPtyId, (id) => loadTerminalSessionPreview(claxedoServerUrl, id))

  const handleConnectError = async (error: unknown) => {
    const id = realPtyId()
    if (!id) return
    if (error instanceof WebSocketCloseError && error.code === 1008) {
      let newId: string | undefined
      try {
        newId = await trackRecovery(recoveryInflight, recoveryAlias, id, () => terminal.clone(id) ?? Promise.resolve(undefined))
      } catch {
        // clone failed; keep the existing terminal visible.
      }
      const dir = directory()
      if (!newId || disposed || !dir) return
      setRealPtyId(newId)
      aliasTerminalSessionPreview(id, newId)
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
      requestTerminalFitOnPaneChange()
    }
  }

  return (
    <Show
      when={pty()}
      keyed
      fallback={
        <div class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      }
    >
      {(pty) => (
        <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
          <Terminal
            pty={pty}
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
                state.workspacePanel.open("review", {
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
