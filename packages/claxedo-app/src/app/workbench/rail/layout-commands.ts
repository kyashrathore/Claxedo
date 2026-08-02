import type { CommandOption } from "@/app/providers/command"

export function createProcessPaneToggleCommand(onSelect: () => void): CommandOption {
  return {
    id: "processPane.toggle",
    title: "Toggle Process Pane",
    category: "View",
    keybind: "mod+shift+;",
    onSelect,
  }
}
