import { describe, expect, test } from "bun:test"

import { restartBehavior, restartMenuLabel, runRestart } from "./restart-policy"

// The bug this pins: in a development run the Electron process is a CHILD of
// `electron-vite dev`, which also owns the renderer's Vite dev server. The quit
// that `app.relaunch()` requires takes that parent pipeline down, so "Restart"
// killed the dev server and came back to a dead renderer. Reload is the only
// honest development behaviour, and the label has to match.

const calls = () => {
  const log: string[] = []
  return {
    log,
    relaunch: () => log.push("relaunch"),
    quit: () => log.push("quit"),
    reload: () => log.push("reload"),
  }
}

describe("restartBehavior", () => {
  test("packaged relaunches, unpackaged reloads", () => {
    expect(restartBehavior(true)).toBe("relaunch")
    expect(restartBehavior(false)).toBe("reload")
  })
})

describe("restartMenuLabel", () => {
  test("packaged keeps Restart", () => {
    expect(restartMenuLabel(true)).toBe("Restart")
  })

  test("unpackaged names what it actually does", () => {
    // The owner's complaint was the label promising a restart it could not
    // deliver. A working reload is fine; a reload labelled "Restart" is not.
    expect(restartMenuLabel(false)).toBe("Reload Window")
  })
})

describe("runRestart", () => {
  test("packaged relaunches and then quits, in that order", () => {
    // Order matters: `app.relaunch()` only registers the re-exec, the quit is
    // what performs it. Quitting first would exit without coming back.
    const c = calls()
    runRestart({ packaged: true, ...c })
    expect(c.log).toEqual(["relaunch", "quit"])
  })

  test("unpackaged reloads and never quits", () => {
    // The whole point: no quit, because the quit is what killed the dev server.
    const c = calls()
    runRestart({ packaged: false, ...c })
    expect(c.log).toEqual(["reload"])
    expect(c.log).not.toContain("quit")
    expect(c.log).not.toContain("relaunch")
  })
})
