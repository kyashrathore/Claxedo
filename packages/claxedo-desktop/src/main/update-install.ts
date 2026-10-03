/** The slice of electron-updater's `autoUpdater` an install drives. */
export type InstallingUpdater = {
  quitAndInstall: () => void
  once: (event: "error", listener: (error: Error) => void) => unknown
}

/**
 * Hands a downloaded update to the updater once this app's daemon is stopped.
 * A failed install leaves the app running with no daemon, so `relaunch` must
 * start this build again, which starts a fresh one. The updater reports most
 * failures as an `error` event, not a throw, and leaves the app running.
 */
export function installDownloadedUpdate(updater: InstallingUpdater, relaunch: (error: unknown) => void) {
  let failed = false
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    relaunch(error)
  }
  updater.once("error", fail)
  try {
    updater.quitAndInstall()
  } catch (error) {
    fail(error)
  }
}
