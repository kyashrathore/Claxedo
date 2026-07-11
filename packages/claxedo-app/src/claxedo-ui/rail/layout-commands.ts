import type { CommandOption } from "@/context/command"

export function createProcessPaneToggleCommand(onSelect: () => void): CommandOption {
  return {
    id: "processPane.toggle",
    title: "Toggle Process Pane",
    category: "View",
    keybind: "mod+shift+;",
    onSelect,
  }
}
