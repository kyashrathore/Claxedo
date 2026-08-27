export const NUMBERED_SURFACE_SHORTCUTS = Array.from({ length: 9 }, (_, index) => ({
  commandId: `claxedo.surface.${index + 1}`,
  keybind: `mod+${index + 1}`,
  number: index + 1,
}))

export function numberedSurfaceShortcutHints(command: {
  has: (id: string) => boolean
  keybind: (id: string) => string
}) {
  return NUMBERED_SURFACE_SHORTCUTS.map((shortcut) =>
    command.has(shortcut.commandId) ? command.keybind(shortcut.commandId) : "",
  )
}

export function sidebarHiddenForCloseShortcut(input: {
  narrowViewport: boolean
  mobileSidebarOpen: boolean
  desktopSidebarHidden: boolean
}) {
  return input.narrowViewport ? !input.mobileSidebarOpen : input.desktopSidebarHidden
}

export function closeFocusedPaneFromShortcut(input: {
  sidebarHidden: boolean
  paneId: string
  contentId: string | null
  closeSurface: (contentId: string) => void
  closePane: (paneId: string) => void
}) {
  if (input.sidebarHidden && input.contentId) {
    input.closeSurface(input.contentId)
    return
  }
  input.closePane(input.paneId)
}
