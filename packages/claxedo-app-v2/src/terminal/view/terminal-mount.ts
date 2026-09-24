import type { Machine } from "@/lib/machine"
import { resolveWorkspaceFileFocus, type WorkspaceFileFocusTarget } from "@/lib/workspace-file-focus"
import type { PlacementId, Server, TerminalId } from "@/server"
import type { RendererBudget } from "../backend/renderer-budget"
import type { TerminalBackend, TerminalBackendOptions } from "../backend/types"
import { attachTerminal, type Attachment } from "../attach"
import { asAppError, type TerminalConnection, type TerminalConnectionEvent, type TerminalRow } from "../model"
import { isLikelyTui } from "../resize"
import { monoFontFamily, observeTheme, terminalColors } from "./terminal-colors"

export type TerminalMountInput = {
  readonly host: HTMLDivElement
  readonly server: Server
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly row: () => TerminalRow | undefined
  readonly connection: Machine<TerminalConnection, TerminalConnectionEvent>
  readonly renderers: RendererBudget
  readonly openFile: (target: WorkspaceFileFocusTarget) => void
  readonly onBackend: (backend: TerminalBackend) => void
}

export type TerminalMount = {
  readonly send: (data: string) => void
  readonly retry: () => void
  readonly dispose: () => void
}

type Attached = { readonly attachment: Attachment; readonly stopTheme: () => void }

function backendOptions(input: TerminalMountInput, likelyAgent: boolean): TerminalBackendOptions {
  return {
    theme: terminalColors(),
    fontFamily: monoFontFamily(),
    renderers: input.renderers,
    image: likelyAgent ? "paste" : "path",
    onUrlClick: (_event, url) => window.open(url, "_blank", "noopener,noreferrer"),
    onFileLinkClick: (path, line, col) => {
      const target = resolveWorkspaceFileFocus(path, input.row()?.cwd ?? "")
      if (target) input.openFile({ path: target.path, line: line ?? target.line, col: col ?? target.col })
    },
  }
}

function attachBackend(input: TerminalMountInput, backend: TerminalBackend, likelyTui: boolean): Attached {
  input.onBackend(backend)
  const stopTheme = observeTheme(() => backend.setTheme(terminalColors()))
  const attachment = attachTerminal({
    server: input.server,
    placementId: input.placementId,
    terminalId: input.terminalId,
    backend,
    host: input.host,
    connection: input.connection,
    likelyTui,
    onPublishFailed: (error) =>
      console.error("Terminal size could not be published", { terminalId: input.terminalId, error }),
  })
  backend.focus()
  return { attachment, stopTheme }
}

function reportStartFailure(input: TerminalMountInput, error: unknown): void {
  input.connection.send({
    type: "failed",
    failure: "start",
    error: asAppError(error, "Terminal backend failed to start"),
  })
}

export function mountTerminal(input: TerminalMountInput): TerminalMount {
  let disposed = false
  let backend: TerminalBackend | undefined
  let attached: Attached | undefined
  const likelyAgent = isLikelyTui({ command: input.row()?.command, title: input.row()?.title })

  const start = async () => {
    const { createBackend } = await import("#terminal-backend")
    if (disposed) return
    const created = await createBackend(input.host, backendOptions(input, likelyAgent))
    if (disposed) return created.dispose()
    backend = created
    attached = attachBackend(input, created, likelyAgent)
  }
  const boot = () =>
    start().catch((error: unknown) => {
      if (!disposed) reportStartFailure(input, error)
    })
  void boot()

  return {
    send: (data) => attached?.attachment.send(data),
    retry: () => {
      if (attached) return attached.attachment.retry()
      input.connection.send({ type: "retry" })
      void boot()
    },
    dispose: () => {
      disposed = true
      attached?.attachment.dispose()
      attached?.stopTheme()
      backend?.dispose()
      backend = undefined
    },
  }
}
