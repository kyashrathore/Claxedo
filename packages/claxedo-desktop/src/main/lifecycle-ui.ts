import { dialog, Menu, Tray } from "electron"

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

export async function confirmQuitDialog(message: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message,
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  })
  return response === 0
}
