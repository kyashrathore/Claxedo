import { describe, expect, test } from "bun:test"
import { createProcessPaneToggleCommand } from "../claxedo-layout-commands"
import { createRailKeyboardCommands, type RailKeyboardCommandActions } from "./rail-keyboard-commands"

describe("P4 keyboard command parity", () => {
  test("keeps the shell chord table pinned to command ids", () => {
    const commands = [
      ...createRailKeyboardCommands(noopActions()),
      createProcessPaneToggleCommand(() => {}),
    ]
    const byKeybind = Object.fromEntries(commands.map((command) => [command.keybind, command.id]))

    expect(byKeybind).toMatchObject({
      "mod+b": "claxedo.sidebar.toggle",
      "mod+w": "claxedo.pane.close",
      "mod+tab": "claxedo.surface.next",
      "mod+shift+tab": "claxedo.surface.previous",
      "mod+shift+;": "processPane.toggle",
      "mod+alt+ArrowLeft": "claxedo.split.focusLeft",
      "mod+alt+ArrowRight": "claxedo.split.focusRight",
    })
    expect(Array.from({ length: 9 }, (_, index) => byKeybind[`mod+${index + 1}`])).toEqual([
      "claxedo.surface.1",
      "claxedo.surface.2",
      "claxedo.surface.3",
      "claxedo.surface.4",
      "claxedo.surface.5",
      "claxedo.surface.6",
      "claxedo.surface.7",
      "claxedo.surface.8",
      "claxedo.surface.9",
    ])
  })
})

function noopActions(): RailKeyboardCommandActions {
  return {
    closeFocusedPane: () => {},
    showNextSurface: () => {},
    showPreviousSurface: () => {},
    toggleSidebar: () => {},
    showSurfaceAtIndex: () => {},
    focusSplitLeft: () => {},
    focusSplitRight: () => {},
  }
}
