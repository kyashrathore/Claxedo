import { describe, expect, test } from "bun:test"
import { createProcessPaneToggleCommand } from "./layout-commands"
import { createRailKeyboardCommands, type RailKeyboardCommandActions } from "./rail-keyboard-commands"
import { resolveKeyMap } from "../workbench/keyboard"

describe("P4 keyboard command parity", () => {
  test("keeps the shell chord table pinned to command ids", () => {
    const commands = [
      ...createRailKeyboardCommands(noopActions()),
      createProcessPaneToggleCommand(() => {}),
    ]
    const byKeybind = Object.fromEntries(commands.map((command) => [command.keybind, command.id]))

    expect(byKeybind).toMatchObject({
      "mod+b": "claxedo.sidebar.toggle",
      "mod+tab": "claxedo.surface.next",
      "mod+shift+tab": "claxedo.surface.previous",
      "mod+shift+;": "processPane.toggle",
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

  test("no chord is bound by both the command registry and the workbench keyboard listener (single dispatch, no double-fire)", () => {
    // Regression for the two-divergent-keyboard-systems finding
    // (core-panes-split-tabs:591 neighborhood): mod+w and mod+alt+Arrow were
    // bound by BOTH the command registry AND the workbench's own window keydown
    // listener, so a single keypress fired two diverging handlers (command =
    // index-based focus / layout.closePane; workbench = geometric focus /
    // wb.split.close). The workbench listener is the self-contained owner of
    // in-pane chords; the command registry must not re-bind them.
    const commandChords = new Set(
      createRailKeyboardCommands(noopActions())
        .map((command) => command.keybind)
        .filter((keybind): keybind is string => typeof keybind === "string"),
    )
    const workbenchChords = Object.values(resolveKeyMap(undefined))

    const doubleBound = workbenchChords.filter((chord) => commandChords.has(chord))
    expect(doubleBound).toEqual([])
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
