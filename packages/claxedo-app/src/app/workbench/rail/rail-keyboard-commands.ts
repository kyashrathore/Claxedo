import type { CommandOption } from "@/app/providers/command"
import { NUMBERED_SURFACE_SHORTCUTS } from "./rail-keyboard-shortcuts"

export type RailKeyboardCommandActions = {
  closeFocusedPane: () => void
  showNextSurface: () => void
  showPreviousSurface: () => void
  toggleSidebar: () => void
  showSurfaceAtIndex: (index: number) => void
  focusSplitLeft: () => void
  focusSplitRight: () => void
}

export type RailKeyboardCommandOptions = {
  numberedSurfaceShortcuts: boolean
}

export function createRailKeyboardCommands(
  actions: RailKeyboardCommandActions,
  options: RailKeyboardCommandOptions,
): CommandOption[] {
  return [
    {
      // No keybind: workbench/keyboard.ts owns mod+w; binding it here too makes
      // one chord fire two diverging handlers. The palette entry stays invokable.
      id: "claxedo.pane.close",
      title: "Close Pane",
      category: "View",
      onSelect: actions.closeFocusedPane,
    },
    {
      id: "claxedo.surface.next",
      title: "Next Surface",
      category: "View",
      keybind: "mod+tab",
      onSelect: actions.showNextSurface,
    },
    {
      id: "claxedo.surface.previous",
      title: "Previous Surface",
      category: "View",
      keybind: "mod+shift+tab",
      onSelect: actions.showPreviousSurface,
    },
    {
      id: "claxedo.sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      keybind: "mod+b",
      onSelect: actions.toggleSidebar,
    },
    ...(options.numberedSurfaceShortcuts
      ? NUMBERED_SURFACE_SHORTCUTS.map((shortcut, index) => ({
          id: shortcut.commandId,
          title: `Switch to Surface ${shortcut.number}`,
          category: "View",
          keybind: shortcut.keybind,
          onSelect: () => actions.showSurfaceAtIndex(index),
        }))
      : []),
    {
      // Keybind intentionally omitted (see claxedo.pane.close above): the
      // workbench listener owns mod+alt+Arrow with geometric, 4-direction focus.
      id: "claxedo.split.focusLeft",
      title: "Focus Left/Top Panel",
      category: "View",
      onSelect: actions.focusSplitLeft,
    },
    {
      id: "claxedo.split.focusRight",
      title: "Focus Right/Bottom Panel",
      category: "View",
      onSelect: actions.focusSplitRight,
    },
  ]
}
