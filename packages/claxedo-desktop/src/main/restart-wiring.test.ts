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
      for (const [index, line] of text.split("\n").entries()) {
        if (!/\bapp\.relaunch\s*\(/.test(line)) continue
        // The legal shape is the `relaunch:` callback handed to runRestart.
        if (/relaunch:\s*\(\)\s*=>\s*app\.relaunch\(\)/.test(line)) continue
        offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("both restart entry points route through runRestart", async () => {
    const index = await read("src/main/index.ts")
    const ipc = await read("src/main/ipc.ts")

    // The application menu item.
    expect(index).toMatch(/restart:\s*\(\)\s*=>\s*\n?\s*runRestart\(/)
    // The IPC channel the renderer's platform.restart() sends on. ANY caller of
    // it gets the safe semantics, which is why it is not a separate branch.
    expect(ipc).toMatch(/ipcMain\.on\("relaunch"/)
    expect(ipc).toMatch(/runRestart\(\{/)
    expect(ipc).toMatch(/packaged: IS_PACKAGED/)
  })

  test("the unpackaged branch reloads the window that asked", async () => {
    // A diagnostics window pressing restart must not reload the main window.
    const ipc = stripComments(await read("src/main/ipc.ts"))
    expect(ipc).toMatch(/reload:\s*\(\)\s*=>\s*event\.sender\.reloadIgnoringCache\(\)/)
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

  test("restart never kills the durable local daemon", async () => {
    const restart = await read("src/renderer/restart.ts")
    expect(restart).not.toMatch(/killSidecar/)
    expect(await read("src/renderer/local.tsx")).not.toMatch(/killSidecar/)
  })
})
