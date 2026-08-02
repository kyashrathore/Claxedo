import { desktopApi } from "./api"
import { restartBehavior } from "../shared/restart-policy"

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
 * The sidecar kill is packaged-only on purpose. A relaunch needs the embedded
 * server stopped so the new process can claim the port, but a development
 * reload keeps the SAME main process and the same server: killing it would
 * reload the window straight into the "server failed to start" state the button
 * is usually being pressed to escape.
 */
export async function restartApp() {
  if (restartBehavior(IS_PACKAGED) === "relaunch") {
    await desktopApi()
      .killSidecar()
      .catch(() => undefined)
  }
  desktopApi().relaunch()
}
