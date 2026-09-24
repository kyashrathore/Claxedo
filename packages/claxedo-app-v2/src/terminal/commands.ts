import { useTranslator } from "@/i18n"
import type { PlacementId } from "@/server"
import { useCommands } from "@/shell"
import { showToast } from "@/ui"
import type { Terminals } from "./context"
import { dictionary } from "./i18n"
import { asAppError } from "./model"

export function useNewTerminalCommand(terminals: Terminals): void {
  const commands = useCommands()
  const t = useTranslator(dictionary)

  const openNew = async (placementId: PlacementId) => {
    const terminal = await terminals.store(placementId).create()
    terminals.open({ placementId, terminalId: terminal.id })
  }

  const run = () => {
    const placementId = terminals.placementId()
    if (!placementId) return
    openNew(placementId).catch((error: unknown) => {
      console.error("Terminal could not be created", {
        placementId,
        error: asAppError(error, "Terminal create failed"),
      })
      showToast({ title: t("terminal.createFailed") })
    })
  }

  commands.register("terminal", () => [
    {
      id: "terminal.new",
      title: t("terminal.command.new"),
      category: t("terminal.title"),
      keybind: "mod+shift+`",
      disabled: terminals.placementId() === undefined,
      onSelect: run,
    },
  ])
}
