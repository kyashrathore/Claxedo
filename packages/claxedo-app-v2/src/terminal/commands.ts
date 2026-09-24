import { useTranslator } from "@/i18n"
import { usePanel } from "@/panel"
import { toAppError, type PlacementId } from "@/server"
import { useCommands } from "@/shell"
import { showToast } from "@/ui"
import { useWorkbench } from "@/workbench"
import type { Terminals } from "./context"
import { dictionary } from "./i18n"
import { terminalPaneKind } from "./pane"

function useStartShell(terminals: Terminals): () => void {
  const panel = usePanel()
  const t = useTranslator(dictionary)
  const openNew = async (placementId: PlacementId) => {
    const terminal = await terminals.store(placementId).create()
    terminals.open({ placementId, terminalId: terminal.id })
  }
  return () => {
    const placementId = terminals.placementId()
    if (!placementId) return
    panel.close()
    openNew(placementId).catch((error: unknown) => {
      console.error("Terminal could not be created", { placementId, error: toAppError(error) })
      showToast({ title: t("terminal.createFailed") })
    })
  }
}

function useToggleTerminal(start: () => void): () => void {
  const workbench = useWorkbench()
  return () => {
    const focused = workbench.selectors.focusedContent()
    if (focused && workbench.content(focused)?.kind.kind === terminalPaneKind.kind) {
      workbench.closeContent(focused)
      return
    }
    start()
  }
}

export function useNewTerminalCommand(terminals: Terminals): void {
  const commands = useCommands()
  const t = useTranslator(dictionary)
  const start = useStartShell(terminals)
  const toggle = useToggleTerminal(start)
  commands.register("terminal", () => [
    {
      id: "terminal.new",
      title: t("terminal.command.new"),
      description: t("terminal.command.new.description"),
      category: t("terminal.title"),
      keybind: "ctrl+alt+t",
      disabled: terminals.placementId() === undefined,
      onSelect: start,
    },
    {
      id: "terminal.toggle",
      title: t("terminal.command.toggle"),
      category: t("terminal.title"),
      keybind: "ctrl+`",
      disabled: terminals.placementId() === undefined,
      onSelect: toggle,
    },
  ])
}
