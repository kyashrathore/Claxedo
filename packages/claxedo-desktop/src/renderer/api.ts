import type { ElectronAPI } from "../preload/types"

/**
 * Post-divorce (plan 006): the global `Window.api` declaration lived in
 * upstream `packages/app`'s `app.tsx`, which is no longer in this program, so
 * every reader asserted `window` into a one-property shape instead. Declared
 * here, beside the two accessors that read it, because `src/preload/index.ts`
 * is what puts it there — `contextBridge.exposeInMainWorld("api", ...)`.
 */
declare global {
  interface Window {
    /** Present only in the desktop renderer; a browser build has no preload. */
    api?: ElectronAPI
  }
}

export function hasDesktopApi() {
  return !!window.api
}

/**
 * Returns the desktop Electron API.
 * Only call from code that runs inside the desktop (Electron) environment.
 */
export function desktopApi(): ElectronAPI {
  const api = window.api
  // Named here rather than left to fail on the first member access, which is
  // what returning an undefined `ElectronAPI` used to do.
  if (!api) throw new Error("desktopApi() was called outside the Electron renderer")
  return api
}
