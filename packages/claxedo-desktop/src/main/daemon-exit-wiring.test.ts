import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

describe("desktop daemon exit wiring", () => {
  test("focus and background changes never release the process daemon lease", () => {
    expect(source).not.toContain('app.on("browser-window-focus"')
    expect(source).not.toContain('app.on("browser-window-blur"')
    expect(source).toContain("daemonLease = await holdClaxedoDaemonLease(")
  })

  test("a normal before-quit path asks the daemon exit lifecycle to release ownership", () => {
    const beforeQuit = source.indexOf('app.on("before-quit"')
    const shutdown = source.indexOf("void shutdown().finally(() => app.quit())", beforeQuit)
    const release = source.indexOf("await daemonExitLifecycle.release(lease)")

    expect(beforeQuit).toBeGreaterThan(-1)
    expect(shutdown).toBeGreaterThan(beforeQuit)
    expect(release).toBeGreaterThan(shutdown)
  })

  test("menu restart and updater exits mark a handoff before quitting", () => {
    const menuHandoff = source.indexOf("daemonExitLifecycle.handoff()", source.indexOf("function wireMenu"))
    const menuRelaunch = source.indexOf("app.relaunch()", menuHandoff)
    const installUpdate = source.indexOf("async function installUpdate")
    const installHandoff = source.indexOf("daemonExitLifecycle.handoff()", installUpdate)
    const quitAndInstall = source.indexOf("autoUpdater.quitAndInstall()", installHandoff)

    expect(menuHandoff).toBeGreaterThan(-1)
    expect(menuRelaunch).toBeGreaterThan(menuHandoff)
    expect(installHandoff).toBeGreaterThan(installUpdate)
    expect(quitAndInstall).toBeGreaterThan(installHandoff)
  })
})
