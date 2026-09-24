import type { PlacementId, Server, TerminalId } from "@/server"
import type { Machine } from "@/lib/machine"
import type { Json } from "@/shell/types"
import type { TerminalBackend } from "../backend/types"
import type { RendererBudget } from "../backend/renderer-budget"
import { attachTerminal, type Attachment } from "../attach"
import { fileLinkTarget } from "../links"
import type { TerminalConnection, TerminalConnectionEvent, TerminalRow } from "../model"
import { isLikelyTui } from "../resize"
import type { OpenPane } from "../store"
import { monoFontFamily, observeTheme, terminalColors } from "./terminal-colors"
import { t } from "../i18n"

export type TerminalMountInput = {
  readonly host: HTMLDivElement
  readonly server: Server
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly row: () => TerminalRow | undefined
  readonly connection: Machine<TerminalConnection, TerminalConnectionEvent>
  readonly renderers: RendererBudget
  readonly openPane: OpenPane
  readonly onBackend: (backend: TerminalBackend) => void
}

export type TerminalMount = {
  readonly retry: () => void
  readonly dispose: () => void
}

function filePaneState(placementId: PlacementId, target: { path: string; line?: number; col?: number }): Json {
  return {
    placementId,
    path: target.path,
    ...(target.line === undefined ? {} : { line: target.line }),
    ...(target.col === undefined ? {} : { col: target.col }),
  }
}

function reportResizeFailure(terminalId: TerminalId, error: unknown): void {
  console.error(t("terminal.resizeFailed"), { terminalId, error })
}

export function mountTerminal(input: TerminalMountInput): TerminalMount {
  let disposed = false
  let backend: TerminalBackend | undefined
  let attachment: Attachment | undefined
  let stopTheme: (() => void) | undefined
  const likelyAgent = isLikelyTui({ command: input.row()?.command, title: input.row()?.title })

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
        if (target) input.openPane("file", filePaneState(input.placementId, target))
      },
    })
    if (disposed) {
      created.dispose()
      return
    }
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

  void start()

  return {
    retry: () => attachment?.retry(),
    dispose: () => {
      disposed = true
      attachment?.dispose()
      stopTheme?.()
      backend?.dispose()
      backend = undefined
    },
  }
}
