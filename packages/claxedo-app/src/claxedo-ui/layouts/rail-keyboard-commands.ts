import type { CommandOption } from "@claxedo/context/command"

export type RailKeyboardCommandActions = {
  closeFocusedPane: () => void
  showNextSurface: () => void
  showPreviousSurface: () => void
  toggleSidebar: () => void
  showSurfaceAtIndex: (index: number) => void
  focusSplitLeft: () => void
  focusSplitRight: () => void
}

export function createRailKeyboardCommands(actions: RailKeyboardCommandActions): CommandOption[] {
  return [
    {
      id: "claxedo.pane.close",
      title: "Close Pane",
      category: "View",
      keybind: "mod+w",
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
      id: "claxedo.surface.reopen",
      title: "Reopen Closed Surface",
      category: "View",
      keybind: "mod+shift+t",
      onSelect: () => {},
    },
    {
      id: "claxedo.sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      keybind: "mod+b",
      onSelect: actions.toggleSidebar,
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `claxedo.surface.${i + 1}`,
      title: `Switch to Surface ${i + 1}`,
      category: "View",
      keybind: `mod+${i + 1}`,
      onSelect: () => actions.showSurfaceAtIndex(i),
    })),
    {
      id: "claxedo.split.focusLeft",
      title: "Focus Left/Top Panel",
      category: "View",
      keybind: "mod+alt+ArrowLeft",
      onSelect: actions.focusSplitLeft,
    },
    {
      id: "claxedo.split.focusRight",
      title: "Focus Right/Bottom Panel",
      category: "View",
      keybind: "mod+alt+ArrowRight",
      onSelect: actions.focusSplitRight,
    },
  ]
}
