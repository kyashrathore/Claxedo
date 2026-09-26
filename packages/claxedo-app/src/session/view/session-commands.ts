import type { PlacementId } from "@/server"
import { draftPath, type Commands } from "@/shell"
import type { SessionScreenText } from "./text"

export function registerSessionCommands(input: {
  readonly commands: Commands
  readonly placementId: () => PlacementId
  readonly active: () => boolean
  readonly navigate: (path: string) => void
  readonly t: SessionScreenText
}) {
  input.commands.register(
    "session",
    () => [
      {
        id: "session.new",
        title: input.t("command.session.new"),
        category: input.t("command.category.session"),
        keybind: "mod+shift+s",
        slash: "new",
        onSelect: () => input.navigate(draftPath(input.placementId())),
      },
    ],
    { owner: { isVisible: input.active, isFocused: input.active } },
  )
}

