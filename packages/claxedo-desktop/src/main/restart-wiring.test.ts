import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// The dev trap is re-introducible by a one-line addition anywhere in the main
// process: any new `app.relaunch()` + quit pair brings back "Restart kills my
// dev server". The policy module is the only place allowed to decide that, so
// these read the sources and pin the wiring rather than the behaviour (which
// `shared/restart-policy.test.ts` covers). Importing the real modules is not an
// option here — they pull in `electron`, whose named exports do not resolve
// outside an Electron runtime.

const root = join(import.meta.dirname, "../..")
const read = (file: string) => Bun.file(join(root, file)).text()

/** Comments explain the hazard by naming it; only real calls count. */
const stripComments = (text: string) =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

describe("restart wiring", () => {
  test("app.relaunch() is only reached through the restart policy", async () => {
    const offenders: string[] = []
    for (const file of ["main/index.ts", "main/ipc.ts", "main/menu.ts", "main/windows.ts"]) {
      const text = stripComments(await read(`src/${file}`))
      const lines = text.split("\n")
      for (const [index, line] of lines.entries()) {
        if (!/\bapp\.relaunch\s*\(/.test(line)) continue
        // The legal shape is the `relaunch:` callback handed to runRestart.
        // It may be a block because restart handoff work must happen before
        // Electron relaunches.
        const prefix = lines.slice(0, index + 1).join("\n")
        const runRestart = prefix.lastIndexOf("runRestart({")
        const relaunch = prefix.lastIndexOf("relaunch:")
        const quit = prefix.lastIndexOf("quit:")
        if (runRestart >= 0 && relaunch > runRestart && quit < relaunch) continue
        offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("every restart entry point routes through the one restartApp", async () => {
    const index = stripComments(await read("src/main/index.ts"))
    const ipc = stripComments(await read("src/main/ipc.ts"))

    expect(index.match(/runRestart\(\{/g)).toHaveLength(1)
    expect(index).toMatch(/function restartApp\(reload: \(\) => void\) \{\n\s*runRestart\(\{/)
    expect(index).toMatch(/installUpdate: autoUpdate\.pending\(\) \?/)
    // The application menu item, recovery's restart, and the IPC channel the
    // renderer's platform.restart() sends on.
    expect(index).toMatch(/restart:\s*\(\)\s*=>\s*restartApp\(/)
    expect(index).toMatch(/onRecovered:[\s\S]*?restartApp\(/)
    expect(index).toMatch(/restart: restartApp,/)
    expect(ipc).toMatch(/ipcMain\.on\("relaunch"[\s\S]*?deps\.restart\(/)
    expect(ipc).not.toMatch(/runRestart|app\.exit\(/)
  })

  test("the unpackaged branch reloads the window that asked", async () => {
    // A diagnostics window pressing restart must not reload the main window.
    const ipc = stripComments(await read("src/main/ipc.ts"))
    expect(ipc).toMatch(/deps\.restart\(\(\)\s*=>\s*event\.sender\.reloadIgnoringCache\(\)\)/)
  })

  test("the menu label comes from the policy, never a hardcoded Restart", async () => {
    const menu = stripComments(await read("src/main/menu.ts"))
    expect(menu).toMatch(/label:\s*restartMenuLabel\(IS_PACKAGED\)/)
    expect(menu).not.toMatch(/label:\s*"Restart"/)
  })

  test("the renderer learns whether it is packaged", async () => {
    // The app-side menu label and the renderer's restart both branch on this,
    // so the injection has to actually carry it.
    expect(await read("src/main/windows.ts")).toMatch(/packaged: globals\.packaged/)
    expect(await read("src/main/index.ts")).toMatch(/packaged: IS_PACKAGED,/)
  })
})
