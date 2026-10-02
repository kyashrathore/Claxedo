import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATE_CHANNEL, UPDATER_ENABLED } from "./constants"
import type { initLogging } from "./logging"

const { autoUpdater } = pkg

type CheckResult = { updateAvailable: boolean; version?: string; failed?: boolean }

export function createAutoUpdate(input: { logger: ReturnType<typeof initLogging> }) {
  const { logger } = input
  let updateReady = false

  const setup = () => {
    if (!UPDATER_ENABLED) return
    autoUpdater.logger = logger
    autoUpdater.channel = UPDATE_CHANNEL
    autoUpdater.allowPrerelease = false
    // Downgrades re-install older builds whose fixes shipped later; the updater
    // must only ever move forward.
    autoUpdater.allowDowngrade = false
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    logger.log("auto updater configured", {
      channel: autoUpdater.channel,
      allowPrerelease: autoUpdater.allowPrerelease,
      allowDowngrade: autoUpdater.allowDowngrade,
      currentVersion: app.getVersion(),
    })
  }

  const check = async (): Promise<CheckResult> => {
    if (!UPDATER_ENABLED) return { updateAvailable: false }
    updateReady = false
    logger.log("checking for updates", {
      currentVersion: app.getVersion(),
      channel: autoUpdater.channel,
      allowPrerelease: autoUpdater.allowPrerelease,
      allowDowngrade: autoUpdater.allowDowngrade,
    })
    try {
      const result = await autoUpdater.checkForUpdates()
      const updateInfo = result?.updateInfo
      logger.log("update metadata fetched", {
        releaseVersion: updateInfo?.version ?? null,
        releaseDate: updateInfo?.releaseDate ?? null,
        releaseName: updateInfo?.releaseName ?? null,
        files: updateInfo?.files?.map((file) => file.url) ?? [],
      })
      const version = result?.updateInfo?.version
      if (result?.isUpdateAvailable === false || !version) {
        logger.log("no update available", {
          reason: "provider returned no newer version",
        })
        return { updateAvailable: false }
      }
      logger.log("update available", { version })
      await autoUpdater.downloadUpdate()
      logger.log("update download completed", { version })
      updateReady = true
      return { updateAvailable: true, version }
    } catch (error) {
      logger.error("update check failed", error)
      return { updateAvailable: false, failed: true }
    }
  }

  const install = async () => {
    if (!updateReady) return
    autoUpdater.quitAndInstall()
  }

  const run = async (alertOnFail: boolean) => {
    if (!UPDATER_ENABLED) return
    logger.log("checkForUpdates invoked", { alertOnFail })
    const result = await check()
    if (!result.updateAvailable) {
      if (result.failed) {
        logger.log("no update decision", { reason: "update check failed" })
        if (!alertOnFail) return
        await dialog.showMessageBox({
          type: "error",
          message: "Update check failed.",
          title: "Update Error",
        })
        return
      }

      logger.log("no update decision", { reason: "already up to date" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "info",
        message: "You're up to date.",
        title: "No Updates",
      })
      return
    }

    const response = await dialog.showMessageBox({
      type: "info",
      message: `Update ${result.version ?? ""} downloaded. Restart now?`,
      title: "Update Ready",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    logger.log("update prompt response", {
      version: result.version ?? null,
      restartNow: response.response === 0,
    })
    if (response.response === 0) {
      await install()
    }
  }

  return { setup, check, install, run }
}
