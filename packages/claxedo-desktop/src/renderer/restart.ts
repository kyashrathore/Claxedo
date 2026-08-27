import { desktopApi } from "./api"

/**
 * Injected by the main process on `dom-ready` alongside `updaterEnabled`. A
 * missing value means the injection has not landed yet; treating that as "not
 * packaged" is the safe read, because the unpackaged branch never quits.
 */
export const IS_PACKAGED = window.__OPENCODE__?.packaged ?? false

/**
 * The renderer's "Restart" — the error page's recovery button and the app menu
 * item both land here. See `shared/restart-policy` for why this cannot be an
 * unconditional relaunch.
 *
 * The local server is a machine-owned daemon. Restarting Electron only drops
 * this renderer's client connection; the replacement process adopts the same
 * daemon so live turns and PTYs keep their authoritative owner.
 */
export async function restartApp() {
  desktopApi().relaunch()
}
