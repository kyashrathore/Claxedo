import type { PlacementId, Server, TerminalId } from "@/server"
import type { Machine } from "@/lib/machine"
import type { TerminalBackend } from "../backend/types"
import type { RendererBudget } from "../backend/renderer-budget"
import { attachTerminal, type Attachment } from "../attach"
import { fileLinkTarget, type FileLinkTarget } from "../links"
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
  readonly openFile: (target: FileLinkTarget) => void
  readonly onBackend: (backend: TerminalBackend) => void
}

export type TerminalMount = {
  readonly send: (data: string) => void
  readonly retry: () => void
  readonly dispose: () => void
}

function reportResizeFailure(terminalId: TerminalId, error: unknown): void {
  console.error("Terminal size could not be published", { terminalId, error })
}

export function mountTerminal(input: TerminalMountInput): TerminalMount {
  let disposed = false
  let backend: TerminalBackend | undefined
  let attachment: Attachment | undefined
  let stopTheme: (() => void) | undefined
  const likelyAgent = isLikelyTui({ command: input.row()?.command, title: input.row()?.title })

  const attach = (created: TerminalBackend) => {
    backend = created
    input.onBackend(created)
    stopTheme = observeTheme(() => created.setTheme(terminalColors()))
    attachment = attachTerminal({
      server: input.server,
      placementId: input.placementId,
      terminalId: input.terminalId,
      backend: created,
      host: input.host,
      connection: input.connection,
      likelyTui: likelyAgent,
      onPublishFailed: (error) => reportResizeFailure(input.terminalId, error),
    })
    created.focus()
  }

  const start = async () => {
    const { createBackend } = await import("#terminal-backend")
    if (disposed) return
    const created = await createBackend(input.host, {
      theme: terminalColors(),
      fontFamily: monoFontFamily(),
      renderers: input.renderers,
      image: likelyAgent ? "paste" : "path",
      onUrlClick: (_event, url) => window.open(url, "_blank", "noopener,noreferrer"),
      onFileLinkClick: (path, line, col) => {
        const target = fileLinkTarget(path, input.row()?.cwd, line, col)
        if (target) input.openFile(target)
      },
    })
    if (disposed) {
      created.dispose()
      return
    }
    attach(created)
  }

  const boot = () => {
    start().catch((error: unknown) => {
      if (!disposed) input.connection.send({ type: "failed", failure: "start", error: asAppError(error, "Terminal backend failed to start") })
    })
  }

  boot()

  return {
    send: (data) => attachment?.send(data),
    retry: () => {
      if (attachment) {
        attachment.retry()
        return
      }
      input.connection.send({ type: "retry" })
      boot()
    },
    dispose: () => {
      disposed = true
      attachment?.dispose()
      stopTheme?.()
      backend?.dispose()
      backend = undefined
    },
  }
}
