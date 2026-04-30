import type { ElectronAPI } from "../../../claxedo-desktop/src/preload/types"

/**
 * Returns the desktop Electron API.
 * Only call from code that runs inside the desktop (Electron) environment.
 */
export function desktopApi(): ElectronAPI {
  return window.api as unknown as ElectronAPI
}
