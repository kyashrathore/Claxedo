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
      // Keybind intentionally omitted: the workbench's own window keydown
      // listener (workbench/keyboard.ts, keyMap.closePane === "mod+w") is the
      // single dispatch owner of this chord. Binding it here too made a single
      // mod+w fire two diverging handlers. The palette entry stays invokable
      // (and retains the desktop last-pane Quit affordance in closeFocusedPane).
      // Full registry consolidation of these two systems is WP-C2.
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
