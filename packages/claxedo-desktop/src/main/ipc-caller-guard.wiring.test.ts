import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/**
 * The guard's two wiring facts, which its unit tests cannot see.
 *
 * `ipc-caller-guard.test.ts` proves the policy decides correctly. Neither of
 * the ways this control actually dies is a policy bug:
 *
 *   1. It is installed after some handlers register. Those handlers keep the
 *      unwrapped `ipcMain.handle`, so they stay open forever — and every test
 *      still passes, because the guard itself works fine.
 *   2. A window is given the preload bridge but never trusted. That fails
 *      loudly (its IPC stops working), so it is the safe direction; the check
 *      below is what makes it fail at review time instead of at runtime.
 *
 * Source scanning is the only way to see either. The entry cannot be imported
 * in a test — it boots Electron.
 */

const mainRoot = path.join(import.meta.dir)
const entry = readFileSync(path.join(mainRoot, "index.ts"), "utf8")
const windows = readFileSync(path.join(mainRoot, "windows.ts"), "utf8")

function count(text: string, needle: string) {
  return text.split(needle).length - 1
}

describe("ipc caller guard wiring", () => {
  test("is installed before any handler registers", () => {
    const installed = entry.indexOf("installIpcCallerGuard({")
    const registered = entry.indexOf("registerIpcHandlers({")

    expect(installed, "index.ts must install the guard").toBeGreaterThan(-1)
    expect(registered, "index.ts must register handlers").toBeGreaterThan(-1)
    expect(installed).toBeLessThan(registered)
  })

  test("every window that gets the preload bridge is trusted", () => {
    // Equal counts, not "at least one": a second window added later with a
    // preload and no trust call is exactly the case worth catching.
    expect(count(windows, "preload: join(")).toBeGreaterThan(0)
    expect(count(windows, "trustWindowWithBridge({")).toBe(count(windows, "preload: join("))
  })

  test("trust is revoked when the window dies", () => {
    // Electron reuses webContents ids. A missing revoke leaves an id trusted
    // for whatever surface receives it next.
    expect(windows).toContain(`win.webContents.once("destroyed"`)
  })

  test("the account's channels register after the guard too", () => {
    // These spend a credential, so an unguarded one is the worst of the sixty
    // to leave open. Same ordering rule, asserted separately because
    // `setupAccount` is a different call site that a future refactor could move
    // above the install without touching `registerIpcHandlers`.
    const installed = entry.indexOf("installIpcCallerGuard({")
    const account = entry.indexOf("setupAccount({")

    expect(account, "index.ts must set up the account").toBeGreaterThan(-1)
    expect(installed).toBeLessThan(account)
  })

  test("the guard is installed exactly once", () => {
    // Installing twice would double-wrap every channel: two guard checks per
    // call, and a second `guardedCount` that silently disagrees with the first.
    const files = readdirSync(mainRoot, { recursive: true }) as string[]
    const callers = files
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => statSync(path.join(mainRoot, file)).isFile())
      .filter((file) => readFileSync(path.join(mainRoot, file), "utf8").includes("installIpcCallerGuard({"))

    expect(callers).toEqual(["index.ts"])
  })

  test("reads the sender from the event rather than trusting an argument", () => {
    // The whole control rests on the caller identity coming from Electron's own
    // event. A `readCaller` that took an id out of the request payload would
    // let the renderer name itself.
    const readCaller = entry.slice(entry.indexOf("readCaller: (event)"), entry.indexOf("onRejected:"))

    expect(readCaller).toContain("ipc.sender.id")
    expect(readCaller).toContain("ipc.senderFrame")
    expect(readCaller).toContain("ipc.sender.mainFrame")
  })
})
