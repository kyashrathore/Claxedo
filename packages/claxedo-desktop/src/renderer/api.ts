import type { ElectronAPI } from "../preload/types"

export function hasDesktopApi() {
  return !!(window as unknown as { api?: ElectronAPI }).api
}

/**
 * Returns the desktop Electron API.
 * Only call from code that runs inside the desktop (Electron) environment.
 */
export function desktopApi(): ElectronAPI {
  // Post-divorce (plan 006): the global Window.api declaration lived in
  // upstream packages/app's app.tsx, which is no longer in this program.
  // The preload script injects it via contextBridge.
  return (window as unknown as { api: ElectronAPI }).api
}
