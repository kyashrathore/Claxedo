import { dialog, Menu, Tray, type BrowserWindow } from "electron"

import { brandedIcon, iconPath } from "./windows"

let tray: Tray | undefined

/** The Windows and Linux way back to a closed window, and to Quit. Held here so it is never collected. */
export function createAppTray(actions: { open: () => void; quit: () => void }) {
  tray = new Tray(brandedIcon(iconPath()).resize({ width: 16, height: 16 }))
  tray.setToolTip("Claxedo")
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Claxedo", click: actions.open },
    { type: "separator" },
    { label: "Quit", click: actions.quit },
  ]))
  tray.on("click", actions.open)
}

/**
 * A visible parent makes the box a sheet that `signal` can close: macOS runs a
 * parentless message box synchronously, which an abort cannot reach.
 */
export async function confirmQuitDialog(message: string, signal: AbortSignal, window: BrowserWindow | undefined): Promise<boolean> {
  const options = {
    type: "warning" as const,
    message,
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    signal,
  }
  const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response === 0
}
