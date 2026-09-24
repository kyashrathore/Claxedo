import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usePanel } from "@/panel"
import { useDialog } from "@/ui"
import { useActivePlacement } from "../active-placement"
import { dictionary } from "../i18n"
import { useCommands } from "./commands"
import { OPEN_FILE_COMMAND } from "./palette-entries"
import type { CommandSource } from "./registrations"
import { DialogSelectFile } from "./select-file"

export function OpenFileCommand(): JSX.Element {
  const t = useTranslator(dictionary)
  const commands = useCommands()
  const dialog = useDialog()
  const panel = usePanel()
  const active = useActivePlacement()
  const open = (source?: CommandSource) =>
    void dialog.show(() => (
      <DialogSelectFile mode={source === "palette" ? "all" : "files"} placementId={active()} onOpenFile={(path) => panel.show({ kind: "file", path })} />
    ))
  commands.register("palette", () => [
    {
      id: OPEN_FILE_COMMAND,
      title: t("shell.command.openFile"),
      description: t("shell.palette.placeholder"),
      category: t("shell.category.file"),
      keybind: "mod+p",
      slash: "open",
      onSelect: open,
    },
  ])
  return null
}
