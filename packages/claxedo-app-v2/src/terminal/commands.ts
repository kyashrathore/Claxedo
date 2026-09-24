import type { CommandEntry } from "@/shell/types"
import { TERMINAL_PANE_KIND, terminalPaneState } from "./pane"
import { useTerminalContext } from "./store"
import { t } from "./i18n"

export function useTerminalCommands(): readonly CommandEntry[] {
  const context = useTerminalContext()
  return [
    {
      id: "terminal.new",
      title: () => t("terminal.command.new"),
      keybinding: "mod+shift+`",
      when: () => context.placementId() !== undefined,
      run: async () => {
        const placementId = context.placementId()
        if (!placementId) return
        const terminal = await context.store(placementId).create()
        context.openPane(TERMINAL_PANE_KIND, terminalPaneState({ placementId, terminalId: terminal.id }))
      },
    },
  ]
}
