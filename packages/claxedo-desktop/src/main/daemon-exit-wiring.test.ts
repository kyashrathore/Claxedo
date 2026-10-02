import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const updater = readFileSync(new URL("./auto-update.ts", import.meta.url), "utf8")

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

  test("restart and updater exits share the normal lease release policy", () => {
    expect(source).not.toContain("daemonExitLifecycle.handoff")
    expect(source).toContain("app.relaunch()")
    expect(updater).toContain("autoUpdater.quitAndInstall()")
    expect(updater).not.toContain("beforeInstall")
  })
})
