import { describe, expect, test } from "bun:test"
import { createProcessPaneToggleCommand } from "./layout-commands"
import { createRailKeyboardCommands, type RailKeyboardCommandActions } from "./rail-keyboard-commands"
import {
  closeFocusedPaneFromShortcut,
  NUMBERED_SURFACE_SHORTCUTS,
  sidebarHiddenForCloseShortcut,
} from "./rail-keyboard-shortcuts"
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
    expect(NUMBERED_SURFACE_SHORTCUTS.map((shortcut) => byKeybind[shortcut.keybind])).toEqual(
      NUMBERED_SURFACE_SHORTCUTS.map((shortcut) => shortcut.commandId),
    )
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

  test("mod+w closes the active surface while the sidebar is hidden", () => {
    const calls: string[] = []

    closeFocusedPaneFromShortcut({
      sidebarHidden: true,
      paneId: "pane-1",
      contentId: "surface-1",
      closeSurface: (id) => calls.push(`surface:${id}`),
      closePane: (id) => calls.push(`pane:${id}`),
    })

    expect(calls).toEqual(["surface:surface-1"])
  })

  test("mod+w closes only the pane while the sidebar is available", () => {
    const calls: string[] = []

    closeFocusedPaneFromShortcut({
      sidebarHidden: false,
      paneId: "pane-1",
      contentId: "surface-1",
      closeSurface: (id) => calls.push(`surface:${id}`),
      closePane: (id) => calls.push(`pane:${id}`),
    })

    expect(calls).toEqual(["pane:pane-1"])
  })

  test("mod+w closes an empty pane when the hidden sidebar has no active surface", () => {
    const calls: string[] = []

    closeFocusedPaneFromShortcut({
      sidebarHidden: true,
      paneId: "pane-empty",
      contentId: null,
      closeSurface: (id) => calls.push(`surface:${id}`),
      closePane: (id) => calls.push(`pane:${id}`),
    })

    expect(calls).toEqual(["pane:pane-empty"])
  })

  test("uses the mobile drawer visibility at narrow widths", () => {
    expect(sidebarHiddenForCloseShortcut({
      narrowViewport: true,
      mobileSidebarOpen: false,
      desktopSidebarHidden: false,
    })).toBe(true)
    expect(sidebarHiddenForCloseShortcut({
      narrowViewport: true,
      mobileSidebarOpen: true,
      desktopSidebarHidden: true,
    })).toBe(false)
    expect(sidebarHiddenForCloseShortcut({
      narrowViewport: false,
      mobileSidebarOpen: false,
      desktopSidebarHidden: false,
    })).toBe(false)
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
